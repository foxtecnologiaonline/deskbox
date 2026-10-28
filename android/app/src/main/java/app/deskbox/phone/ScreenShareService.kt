package app.deskbox.phone

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.display.DisplayManager
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.view.Display
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.IntentCompat
import org.json.JSONObject

/**
 * Serviço em primeiro plano (type mediaProjection) que mantém a captura de tela e a conexão de sinalização
 * com o Deskbox enquanto o compartilhamento estiver ativo.
 */
class ScreenShareService : Service(), SignalingClient.Listener {

    private lateinit var prefs: Prefs
    private val main = Handler(Looper.getMainLooper())

    private var engine: RtcEngine? = null
    private var signaling: SignalingClient? = null
    private var peer: PeerSession? = null
    private var peerGeneration = 0
    private var displayListener: DisplayManager.DisplayListener? = null
    private var lastRealSize: Pair<Int, Int>? = null
    private var shuttingDown = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent != null && intent.action == ACTION_START) {
            if (engine == null) begin(intent)
        } else {
            shutdown() // ACTION_STOP, ou reinício do sistema sem intent
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        cleanup()
        super.onDestroy()
    }

    private fun begin(intent: Intent) {
        createChannel()
        // Android 14+: o serviço precisa estar em primeiro plano (com o type correto) ANTES de usar o MediaProjection.
        try {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                buildNotification("Conectando…"),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            )
        } catch (e: Exception) {
            Log.e(TAG, "startForeground falhou", e)
            ShareStatus.update(false, "Não foi possível iniciar o serviço: ${e.message}")
            shutdown()
            return
        }

        val projectionData = IntentCompat.getParcelableExtra(intent, EXTRA_RESULT_DATA, Intent::class.java)
        val host = intent.getStringExtra(EXTRA_HOST).orEmpty()
        val port = intent.getIntExtra(EXTRA_PORT, Prefs.DEFAULT_PORT)
        val code = intent.getStringExtra(EXTRA_CODE)
        if (projectionData == null || host.isBlank()) {
            ShareStatus.update(false, "Dados de captura ausentes")
            shutdown()
            return
        }

        try {
            engine = RtcEngine(applicationContext, projectionData) {
                main.post {
                    ShareStatus.update(false, "Captura de tela encerrada")
                    shutdown()
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Falha ao iniciar a captura", e)
            ShareStatus.update(false, "Falha ao iniciar a captura: ${e.message}")
            shutdown()
            return
        }

        lastRealSize = Screen.realSize(this)
        registerDisplayListener()
        setStatus("Conectando a $host:$port…")
        signaling = SignalingClient(prefs, this).also { it.connect(host, port, code) }
    }

    // --- SignalingClient.Listener (sempre na thread principal) ---

    override fun onConnected() {
        setStatus("Conectado ao Deskbox")
    }

    override fun onMessage(type: String, message: JSONObject) {
        when (type) {
            "paired" -> setStatus("Pareado — aguardando visualização no Deskbox")
            "ready" -> if (peer == null) setStatus("Conectado — aguardando visualização no Deskbox")
            "start" -> startPeer()
            "answer" -> peer?.onRemoteAnswer(message.optString("sdp"))
            "ice" -> message.optJSONObject("candidate")?.let { peer?.onRemoteIce(it) }
            "stop" -> stopPeer()
        }
    }

    override fun onDisconnected(willRetry: Boolean) {
        stopPeer(announce = false)
        setStatus("Reconectando ao Deskbox…")
    }

    override fun onFatalError(reason: String) {
        val text = when (reason) {
            "bad_code" -> "Código inválido. Gere um novo código no Deskbox."
            "expired" -> "Código expirado. Gere um novo código no Deskbox."
            "bad_token" -> "Pareamento perdido. Pareie de novo com um código."
            "rate_limited" -> "Muitas tentativas. Aguarde alguns minutos."
            else -> "Erro de conexão com o Deskbox ($reason)"
        }
        ShareStatus.update(false, text)
        shutdown()
    }

    // --- Sessões de visualização ---

    private fun startPeer() {
        val currentEngine = engine ?: return
        stopPeer(announce = false)
        val generation = ++peerGeneration
        val session = PeerSession(
            context = this,
            engine = currentEngine,
            sendSignal = { signaling?.send(it) },
            // Ignora o aviso de uma sessão antiga que cai depois de já existir uma nova.
            onClosed = { main.post { if (generation == peerGeneration) stopPeer() } }
        )
        peer = session
        session.start()
        setStatus("Transmitindo para o Deskbox")
    }

    private fun stopPeer(announce: Boolean = true) {
        val session = peer ?: return
        peer = null
        session.close()
        if (announce) setStatus("Conectado — aguardando visualização no Deskbox")
    }

    // --- Rotação da tela ---

    private fun registerDisplayListener() {
        val manager = getSystemService(DISPLAY_SERVICE) as DisplayManager
        val listener = object : DisplayManager.DisplayListener {
            override fun onDisplayAdded(displayId: Int) {}
            override fun onDisplayRemoved(displayId: Int) {}

            override fun onDisplayChanged(displayId: Int) {
                if (displayId != Display.DEFAULT_DISPLAY) return
                val size = Screen.realSize(this@ScreenShareService)
                if (size == lastRealSize) return
                lastRealSize = size
                engine?.resize(size.first, size.second)
                peer?.sendInfo()
            }
        }
        displayListener = listener
        manager.registerDisplayListener(listener, main)
    }

    // --- Ciclo de vida ---

    private fun shutdown() {
        if (shuttingDown) return
        shuttingDown = true
        cleanup()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun cleanup() {
        displayListener?.let {
            (getSystemService(DISPLAY_SERVICE) as DisplayManager).unregisterDisplayListener(it)
        }
        displayListener = null
        signaling?.close()
        signaling = null
        peer?.close()
        peer = null
        engine?.dispose()
        engine = null
        if (ShareStatus.running) ShareStatus.update(false, "Parado")
    }

    // --- Notificação / status ---

    private fun setStatus(text: String) {
        ShareStatus.update(true, text)
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(NOTIFICATION_ID, buildNotification(text))
    }

    private fun createChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notif_channel_name),
            NotificationManager.IMPORTANCE_LOW
        )
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(channel)
    }

    private fun buildNotification(text: String): Notification {
        val stop = PendingIntent.getService(
            this,
            0,
            Intent(this, ScreenShareService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_share)
            .setContentTitle("Deskbox — tela compartilhada")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(0, "Parar", stop)
            .build()
    }

    companion object {
        const val ACTION_START = "app.deskbox.phone.START"
        const val ACTION_STOP = "app.deskbox.phone.STOP"
        const val EXTRA_RESULT_DATA = "resultData"
        const val EXTRA_HOST = "host"
        const val EXTRA_PORT = "port"
        const val EXTRA_CODE = "code"

        private const val TAG = "ScreenShareService"
        private const val CHANNEL_ID = "deskbox_share"
        private const val NOTIFICATION_ID = 1
    }
}
