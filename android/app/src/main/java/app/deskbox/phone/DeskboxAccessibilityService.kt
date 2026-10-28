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
            "back" -> GLOBAL_ACTION_BACK
            "home" -> GLOBAL_ACTION_HOME
            "recents" -> GLOBAL_ACTION_RECENTS
            "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
            else -> return
        }
        performGlobalAction(action)
    }

    /**
     * Insere [text] na posição do cursor (ou no lugar da seleção) do campo com foco de entrada via
     * ACTION_SET_TEXT e reposiciona o cursor depois do texto inserido. Nunca mexe em campo de senha.
     */
    @Suppress("DEPRECATION")
    private fun typeText(text: String) {
        if (text.isEmpty()) return
        var root: AccessibilityNodeInfo? = null
        var input: AccessibilityNodeInfo? = null
        try {
            root = rootInActiveWindow ?: return
            input = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return
            // Senha: o texto exposto ao serviço é mascarado — reescrevê-lo corromperia o campo (e não vamos digitar nele).
            if (input.isPassword || !input.isEditable) return

            val current = if (input.isShowingHintText) "" else input.text?.toString().orEmpty()
            var start = input.textSelectionStart
            var end = input.textSelectionEnd
            if (start < 0 || end < 0 || start > current.length || end > current.length) {
                start = current.length
                end = current.length
            }
            if (start > end) {
                val swap = start
                start = end
                end = swap
            }

            val updated = current.substring(0, start) + text + current.substring(end)
            val setTextArgs = Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, updated)
            }
            if (!input.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, setTextArgs)) return

            val cursor = start + text.length
            val selectionArgs = Bundle().apply {
                putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, cursor)
                putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, cursor)
            }
            input.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, selectionArgs)
        } finally {
            // recycle() é obrigatório antes do API 33 e inofensivo depois.
            if (Build.VERSION.SDK_INT < 33) {
                input?.recycle()
                root?.recycle()
            }
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
