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
 * Serviço em primeiro plano (type mediaProjection) que mantém a captura de tela e a sinalização com o
 * Deskbox enquanto o compartilhamento estiver ativo. Dois caminhos ao mesmo tempo:
 * - **direto** ([SignalingClient]): o celular conecta no computador (IP do QR) — só se houver IP;
 * - **reverso** ([LinkServer]): o computador conecta no celular — sempre; resolve o firewall do Windows
 *   bloqueando conexões de entrada (Deskbox portátil sem admin, rede Pública).
 * O que abrir a visualização (`start`) é o canal daquela sessão de vídeo.
 */
class ScreenShareService : Service() {

    private lateinit var prefs: Prefs
    private val main = Handler(Looper.getMainLooper())

    private var engine: RtcEngine? = null
    private var signaling: SignalingClient? = null
    private var link: LinkServer? = null
    private var peer: PeerSession? = null
    private var peerChannel: SignalChannel? = null
    private var directConnected = false
    private var linkConnected = false
    private var directError: String? = null
    private var directTarget: String? = null
    private var peerGeneration = 0
    private var displayListener: DisplayManager.DisplayListener? = null
    private var lastDisplay: Triple<Int, Int, Int>? = null
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
            abort("Não foi possível iniciar o serviço: ${e.message}")
            return
        }

        try {
            startSharing(intent)
        } catch (t: Throwable) {
            // Qualquer falha no meio da inicialização: o RtcEngine já descartou o que criou; aqui soltamos o resto
            // (sinalização, listener de display) mesmo com `engine` ainda nulo.
            Log.e(TAG, "Falha ao iniciar o compartilhamento", t)
            abort("Falha ao iniciar o compartilhamento: ${t.message}")
        }
    }

    private fun startSharing(intent: Intent) {
        val projectionData = IntentCompat.getParcelableExtra(intent, EXTRA_RESULT_DATA, Intent::class.java)
        val hosts = intent.getStringExtra(EXTRA_HOST).orEmpty()
            .split(',', ' ', ';').map { it.trim() }.filter { it.isNotEmpty() }
        val port = intent.getIntExtra(EXTRA_PORT, Prefs.DEFAULT_PORT)
        val code = intent.getStringExtra(EXTRA_CODE)
        if (projectionData == null) {
            abort("Dados de captura ausentes")
            return
        }
        // Nem inicia a captura de tela se algum destino não for da rede local.
        if (hosts.any { !HostPolicy.isLocalHost(it) }) {
            abort(HostPolicy.MESSAGE)
            return
        }

        engine = RtcEngine(applicationContext, projectionData) {
            main.post {
                ShareStatus.update(false, "Captura de tela encerrada")
                shutdown()
            }
        }

        lastDisplay = currentDisplay()
        registerDisplayListener()

        // Reverso: sempre (é o que funciona quando o firewall do computador barra o modo direto).
        val server = LinkServer(prefs, listenerFor(direct = false)) { info -> ShareStatus.updateLink(info) }
        if (server.start()) {
            link = server
        } else if (hosts.isEmpty()) {
            abort("Não foi possível abrir a porta para o computador conectar")
            return
        }

        if (hosts.isNotEmpty()) {
            directTarget = hosts.first()
            signaling = SignalingClient(prefs, listenerFor(direct = true)).also { it.connect(hosts, port, code) }
        }
        refreshStatus()
    }

    private fun abort(message: String) {
        ShareStatus.update(false, message)
        shutdown()
    }

    // --- Sinalização (callbacks sempre na thread principal) ---

    private fun listenerFor(direct: Boolean) = object : SignalingClient.Listener {
        private fun channel(): SignalChannel? = if (direct) signaling else link

        override fun onConnected() {
            if (direct) {
                directConnected = true
                directError = null
            } else {
                linkConnected = true
            }
            refreshStatus()
        }

        override fun onMessage(type: String, message: JSONObject) {
            val from = channel() ?: return
            when (type) {
                "paired", "ready" -> refreshStatus()
                "start" -> startPeer(from)
                "answer" -> if (from === peerChannel) peer?.onRemoteAnswer(message.optString("sdp"))
                "ice" -> if (from === peerChannel) message.optJSONObject("candidate")?.let { peer?.onRemoteIce(it) }
                "stop" -> if (from === peerChannel) stopPeer()
            }
        }

        override fun onDisconnected(willRetry: Boolean) {
            if (direct) directConnected = false else linkConnected = false
            if (channel() === peerChannel) stopPeer(announce = false)
            refreshStatus()
        }

        override fun onFatalError(reason: String) {
            if (!direct) return
            val text = when (reason) {
                "bad_code" -> "Código inválido. Gere um novo código no Deskbox."
                "expired" -> "Código expirado. Gere um novo código no Deskbox."
                "bad_token" -> "Pareamento perdido. Pareie de novo com um código."
                "rate_limited" -> "Muitas tentativas. Aguarde alguns minutos."
                "bad_host" -> HostPolicy.MESSAGE
                "bad_request" -> "Pedido inválido: confira o endereço, a porta e o código."
                else -> "Erro de conexão com o Deskbox ($reason)"
            }
            if (signaling === peerChannel) stopPeer(announce = false)
            signaling?.close()
            signaling = null
            directConnected = false
            if (link == null) {
                ShareStatus.update(false, text)
                shutdown()
            } else {
                // O caminho reverso continua aberto: o computador ainda pode conectar pelo endereço do celular.
                directError = text
                refreshStatus()
            }
        }
    }

    // --- Sessões de visualização ---

    private fun startPeer(channel: SignalChannel) {
        val currentEngine = engine ?: return
        stopPeer(announce = false)
        val generation = ++peerGeneration
        val session = PeerSession(
            context = this,
            engine = currentEngine,
            sendSignal = { channel.send(it) },
            // Ignora o aviso de uma sessão antiga que cai depois de já existir uma nova.
            onClosed = { main.post { if (generation == peerGeneration) stopPeer() } }
        )
        peer = session
        peerChannel = channel
        session.start()
        refreshStatus()
    }

    private fun stopPeer(announce: Boolean = true) {
        val session = peer ?: return
        peer = null
        peerChannel = null
        session.close()
        if (announce) refreshStatus()
    }

    private fun refreshStatus() {
        if (shuttingDown) return
        val text = when {
            peer != null -> "Transmitindo para o Deskbox"
            directConnected || linkConnected -> "Conectado ao Deskbox — aguardando visualização"
            else -> buildString {
                directError?.let { append(it).append(' ') }
                if (signaling != null) append("Procurando o Deskbox em ${directTarget.orEmpty()}…")
                else append("Aguardando o Deskbox conectar…")
            }
        }
        setStatus(text)
    }

    // --- Rotação da tela ---

    /** (largura, altura, rotação em graus): comparar só w×h não percebe 180° (nem 90°↔270° em tela quadrada). */
    private fun currentDisplay(): Triple<Int, Int, Int> {
        val (width, height) = Screen.realSize(this)
        return Triple(width, height, Screen.rotationDegrees(this))
    }

    private fun registerDisplayListener() {
        val manager = getSystemService(DISPLAY_SERVICE) as DisplayManager
        val listener = object : DisplayManager.DisplayListener {
            override fun onDisplayAdded(displayId: Int) {}
            override fun onDisplayRemoved(displayId: Int) {}

            override fun onDisplayChanged(displayId: Int) {
                if (displayId != Display.DEFAULT_DISPLAY) return
                val display = currentDisplay()
                if (display == lastDisplay) return
                lastDisplay = display
                // O quadro capturado NÃO é recriado (Android 14 proíbe um 2º VirtualDisplay no mesmo
                // MediaProjection); o viewer só precisa saber a nova geometria e o celular compensa o
                // letterbox no mapeamento dos toques (FrameGeometry).
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
        link?.close()
        link = null
        ShareStatus.updateLink(null)
        peer?.close()
        peer = null
        peerChannel = null
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
