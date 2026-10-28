package app.deskbox.phone

import android.os.Build
import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlin.math.min

/**
 * Cliente WebSocket de sinalização (docs/phone-protocol.md). Reconecta com backoff (1 s → 30 s)
 * usando o token pareado. Todos os callbacks de [Listener] são entregues na thread principal.
 *
 * Só conecta em hosts de rede local ([HostPolicy]); o `hello` leva APENAS o `code` quando há código
 * (1º pareamento) e só o `token` nas reconexões — o token antigo é substituído somente quando chega `paired`.
 */
class SignalingClient(
    private val prefs: Prefs,
    private val listener: Listener
) {
    interface Listener {
        fun onConnected()
        fun onMessage(type: String, message: JSONObject)
        fun onDisconnected(willRetry: Boolean)
        fun onFatalError(reason: String)
    }

    private val client = OkHttpClient.Builder()
        .pingInterval(15, TimeUnit.SECONDS)
        // Defesa em profundidade: o endereço RESOLVIDO também precisa ser local e redirecionamentos HTTP
        // (que poderiam levar o handshake para fora da LAN) não são seguidos.
        .dns(HostPolicy.localOnlyDns)
        .followRedirects(false)
        .followSslRedirects(false)
        .build()
    private val main = Handler(Looper.getMainLooper())

    @Volatile
    private var socket: WebSocket? = null

    @Volatile
    private var host = ""

    @Volatile
    private var port = Prefs.DEFAULT_PORT

    @Volatile
    private var code: String? = null

    @Volatile
    private var closedByUser = false

    @Volatile
    private var attempt = 0

    /** Incrementa a cada novo socket/fechamento; callbacks de sockets antigos são ignorados. */
    @Volatile
    private var generation = 0

    private val retryRunnable = Runnable { if (!closedByUser) open() }

    fun connect(host: String, port: Int, code: String?) {
        this.host = host.trim()
        this.port = port
        this.code = code?.trim()?.takeIf { it.isNotEmpty() }
        attempt = 0
        // Antes de abrir o socket e antes de enviar code/token: só rede local.
        if (!HostPolicy.isLocalHost(this.host)) {
            closedByUser = true
            main.post { listener.onFatalError("bad_host") }
            return
        }
        if (this.code == null && prefs.token.isNullOrEmpty()) {
            closedByUser = true
            main.post { listener.onFatalError("bad_request") }
            return
        }
        closedByUser = false
        open()
    }

    fun send(message: JSONObject): Boolean = socket?.send(message.toString()) ?: false

    fun close() {
        closedByUser = true
        generation++
        main.removeCallbacks(retryRunnable)
        socket?.let {
            it.send(JSONObject().put("type", "bye").toString())
            it.close(1000, "bye")
        }
        socket = null
    }

    private fun open() {
        // Incrementa ANTES de cancelar o socket antigo: o onFailure dele chega com a geração velha e é ignorado.
        val gen = ++generation
        socket?.cancel()
        val hostPart = if (host.contains(':') && !host.startsWith("[")) "[$host]" else host
        val request = try {
            Request.Builder().url("ws://$hostPart:$port/signal").build()
        } catch (e: IllegalArgumentException) {
            closedByUser = true
            main.post { if (gen == generation) listener.onFatalError("bad_request") }
            return
        }
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (gen != generation) return
                attempt = 0
                webSocket.send(buildHello().toString())
                main.post { if (gen == generation) listener.onConnected() }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (gen != generation) return
                val json = try {
                    JSONObject(text)
                } catch (e: Exception) {
                    return
                }
                handleMessage(gen, json)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                scheduleRetry(gen)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                scheduleRetry(gen)
            }
        })
    }

    private fun buildHello(): JSONObject {
        val hello = JSONObject()
            .put("type", "hello")
            .put("role", "phone")
            .put("deviceId", prefs.deviceId)
            .put("deviceName", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
        val pendingCode = code
        if (pendingCode != null) {
            // 1º pareamento: só o código. O token antigo (se existir) fica intocado até chegar `paired`.
            hello.put("code", pendingCode)
        } else {
            prefs.token?.takeIf { it.isNotEmpty() }?.let { hello.put("token", it) }
        }
        return hello
    }

    private fun handleMessage(gen: Int, json: JSONObject) {
        val type = json.optString("type")
        when (type) {
            "paired" -> {
                val newToken = json.optString("token")
                if (newToken.isNotEmpty()) {
                    prefs.token = newToken
                    code = null
                }
            }
            "error" -> {
                val reason = json.optString("reason", "bad_request")
                if (reason == "bad_token") prefs.token = null
                // `error` é terminal: o servidor fecha o WS em seguida e NÃO devemos reconectar em loop.
                closedByUser = true
                main.post {
                    if (gen == generation) {
                        generation++
                        main.removeCallbacks(retryRunnable)
                        listener.onFatalError(reason)
                    }
                }
                return
            }
        }
        main.post { if (gen == generation) listener.onMessage(type, json) }
    }

    private fun scheduleRetry(gen: Int) {
        if (gen != generation || closedByUser) return
        val delay = min(30_000L, 1_000L shl min(attempt, 5))
        attempt++
        main.post {
            if (gen != generation || closedByUser) return@post
            listener.onDisconnected(true)
            main.removeCallbacks(retryRunnable)
            main.postDelayed(retryRunnable, delay)
        }
    }
}
