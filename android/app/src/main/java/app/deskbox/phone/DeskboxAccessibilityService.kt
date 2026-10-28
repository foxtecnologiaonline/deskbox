package app.deskbox.phone

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.graphics.Path
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONObject

/**
 * Executa no celular os comandos que chegam pelo DataChannel `control` (docs/phone-protocol.md).
 * Coordenadas chegam normalizadas (0..1) em relação ao QUADRO de vídeo transmitido; [FrameGeometry] as
 * converte em pixels reais da tela atual, compensando o letterbox quando a tela girou.
 */
class DeskboxAccessibilityService : AccessibilityService() {

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        A11yState.set(true)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // Só usamos o serviço para injetar gestos; não observamos eventos.
    }

    override fun onInterrupt() {}

    override fun onUnbind(intent: Intent?): Boolean {
        release()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        release()
        super.onDestroy()
    }

    private fun release() {
        if (instance === this) instance = null
        A11yState.set(false)
    }

    private fun gesture(path: Path, durationMs: Long) {
        val duration = durationMs.coerceIn(1L, GestureDescription.getMaxGestureDuration())
        val stroke = GestureDescription.StrokeDescription(path, 0L, duration)
        dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), null, null)
    }

    private fun tap(x: Float, y: Float, durationMs: Long) {
        // Um caminho de um único ponto é um toque que não se move.
        gesture(Path().apply { moveTo(x, y) }, durationMs)
    }

    private fun swipe(x1: Float, y1: Float, x2: Float, y2: Float, durationMs: Long) {
        gesture(Path().apply {
            moveTo(x1, y1)
            lineTo(x2, y2)
        }, durationMs)
    }

    private fun key(name: String) {
        val action = when (name) {
            "enter" -> return enter()
            "backspace" -> return backspace()
            "back" -> GLOBAL_ACTION_BACK
            "home" -> GLOBAL_ACTION_HOME
            "recents" -> GLOBAL_ACTION_RECENTS
            "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
            else -> return
        }
        performGlobalAction(action)
    }

    /**
     * Roda [block] com o campo de texto que tem o foco de entrada (e libera os nós depois). Campo de senha só
     * quando [allowPassword]: o texto exposto ao serviço é mascarado, então reescrevê-lo corromperia o campo —
     * mas apertar Enter nele (enviar o login) é seguro.
     */
    @Suppress("DEPRECATION")
    private fun withFocusedInput(allowPassword: Boolean = false, block: (AccessibilityNodeInfo) -> Unit) {
        var root: AccessibilityNodeInfo? = null
        var input: AccessibilityNodeInfo? = null
        try {
            root = rootInActiveWindow ?: return
            input = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return
            if (!input.isEditable || (input.isPassword && !allowPassword)) return
            block(input)
        } finally {
            // recycle() é obrigatório antes do API 33 e inofensivo depois.
            if (Build.VERSION.SDK_INT < 33) {
                input?.recycle()
                root?.recycle()
            }
        }
    }

    private fun currentText(input: AccessibilityNodeInfo): String =
        if (input.isShowingHintText) "" else input.text?.toString().orEmpty()

    /** Seleção atual (start <= end) ou o fim do texto quando o campo não informa o cursor. */
    private fun selection(input: AccessibilityNodeInfo, current: String): Pair<Int, Int> {
        var start = input.textSelectionStart
        var end = input.textSelectionEnd
        if (start < 0 || end < 0 || start > current.length || end > current.length) {
            start = current.length
            end = current.length
        }
        return if (start <= end) start to end else end to start
    }

    /** Troca [start, end) por [insert] via ACTION_SET_TEXT e põe o cursor logo depois do que entrou. */
    private fun replaceRange(input: AccessibilityNodeInfo, current: String, start: Int, end: Int, insert: String) {
        val updated = current.substring(0, start) + insert + current.substring(end)
        val setTextArgs = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, updated)
        }
        if (!input.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, setTextArgs)) return
        val cursor = start + insert.length
        val selectionArgs = Bundle().apply {
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, cursor)
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, cursor)
        }
        input.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, selectionArgs)
    }

    /** Insere [text] na posição do cursor (ou no lugar da seleção) do campo com foco. Nunca em campo de senha. */
    private fun typeText(text: String) {
        if (text.isEmpty()) return
        withFocusedInput { input ->
            val current = currentText(input)
            val (start, end) = selection(input, current)
            replaceRange(input, current, start, end, text)
        }
    }

    /** Apaga a seleção, ou o caractere antes do cursor (inteiro, mesmo emoji/par substituto). */
    private fun backspace() {
        withFocusedInput { input ->
            val current = currentText(input)
            val (start, end) = selection(input, current)
            when {
                start != end -> replaceRange(input, current, start, end, "")
                start > 0 -> replaceRange(input, current, current.offsetByCodePoints(start, -1), start, "")
            }
        }
    }

    /**
     * Enter: a ação do teclado do campo (enviar mensagem, buscar, próximo...) — API 30+. Sem ela (ou se o campo
     * não aceitar), quebra a linha.
     */
    private fun enter() {
        withFocusedInput(allowPassword = true) { input ->
            if (Build.VERSION.SDK_INT >= 30 &&
                input.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
            ) {
                return@withFocusedInput
            }
            if (input.isPassword) return@withFocusedInput
            val current = currentText(input)
            val (start, end) = selection(input, current)
            replaceRange(input, current, start, end, "\n")
        }
    }

    private fun handle(message: JSONObject) {
        val (width, height) = Screen.realSize(this)

        fun point(xName: String, yName: String): Pair<Float, Float> =
            FrameGeometry.toScreenPixels(message.optDouble(xName, 0.0), message.optDouble(yName, 0.0), width, height)

        when (message.optString("t")) {
            "tap" -> {
                val (x, y) = point("x", "y")
                tap(x, y, TAP_MS)
            }
            "longpress" -> {
                val (x, y) = point("x", "y")
                tap(x, y, message.optLong("ms", LONG_PRESS_MS))
            }
            "swipe" -> {
                val (x1, y1) = point("x1", "y1")
                val (x2, y2) = point("x2", "y2")
                swipe(x1, y1, x2, y2, message.optLong("ms", SWIPE_MS))
            }
            "key" -> key(message.optString("key"))
            "text" -> typeText(message.optString("text"))
        }
    }

    companion object {
        private const val TAP_MS = 50L
        private const val LONG_PRESS_MS = 600L
        private const val SWIPE_MS = 300L

        @Volatile
        var instance: DeskboxAccessibilityService? = null
            private set

        private val main = Handler(Looper.getMainLooper())

        /** Entrada vinda da thread do WebRTC: despacha para a thread principal e ignora se o serviço está desligado. */
        fun dispatchControl(message: JSONObject) {
            val service = instance ?: return
            main.post { service.handle(message) }
        }
    }
}
