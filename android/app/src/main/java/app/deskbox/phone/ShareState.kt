package app.deskbox.phone

import android.os.Handler
import android.os.Looper
import java.util.concurrent.CopyOnWriteArraySet

/** Estado do compartilhamento, lido pela UI (MainActivity) e escrito pelo ScreenShareService. */
object ShareStatus {
    @Volatile
    var running: Boolean = false
        private set

    @Volatile
    var message: String = "Parado"
        private set

    @Volatile
    var listener: (() -> Unit)? = null

    private val main = Handler(Looper.getMainLooper())

    fun update(running: Boolean, message: String) {
        this.running = running
        this.message = message
        main.post { listener?.invoke() }
    }
}

/** Se o serviço de acessibilidade (que injeta toques) está ativo. Sem ele o Deskbox só espelha a tela. */
object A11yState {
    @Volatile
    var enabled: Boolean = false
        private set

    private val listeners = CopyOnWriteArraySet<(Boolean) -> Unit>()

    fun set(value: Boolean) {
        if (enabled == value) return
        enabled = value
        listeners.forEach { it(value) }
    }

    fun addListener(listener: (Boolean) -> Unit) {
        listeners.add(listener)
    }

    fun removeListener(listener: (Boolean) -> Unit) {
        listeners.remove(listener)
    }
}
