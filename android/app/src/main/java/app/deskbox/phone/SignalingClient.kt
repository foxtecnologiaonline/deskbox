package app.deskbox.phone

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
 * Cliente WebSocket de sinalização do modo direto (docs/phone-protocol.md). Reconecta com backoff (1 s → 30 s)
 * usando o token pareado. Todos os callbacks de [Listener] são entregues na thread principal.
 * Aceita vários endereços do computador (o QR traz alternativos): enquanto não conecta, tenta o próximo.
 *
 * Só conecta em hosts de rede local ([HostPolicy]); o `hello` leva APENAS o `code` quando há código
 * (1º pareamento) e só o `token` nas reconexões — o token antigo é substituído somente quando chega `paired`.
 */
class SignalingClient(
    private val prefs: Prefs,
    private val listener: Listener
) : SignalChannel {
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
    private var hosts: List<String> = emptyList()

    @Volatile
    private var hostIndex = 0

    /** Algum socket já abriu com o endereço atual (então falha depois disso não é motivo para trocar de endereço). */
    @Volatile
    private var openedOnce = false

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

    fun connect(hosts: List<String>, port: Int, code: String?) {
        this.hosts = hosts.map { it.trim() }.filter { it.isNotEmpty() }
        this.hostIndex = 0
        this.openedOnce = false
        this.port = port
        this.code = code?.trim()?.takeIf { it.isNotEmpty() }
        attempt = 0
        // Antes de abrir o socket e antes de enviar code/token: só rede local (todos os endereços).
        if (this.hosts.isEmpty() || this.hosts.any { !HostPolicy.isLocalHost(it) }) {
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

    override fun send(message: JSONObject): Boolean = socket?.send(message.toString()) ?: false

    override fun close() {
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
        val host = hosts[hostIndex % hosts.size]
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
                if (!openedOnce && hosts.size > 1) {
                    // Guarda o endereço que funcionou na frente, pra próxima vez começar por ele.
                    prefs.host = (listOf(host) + hosts.filter { it != host }).joinToString(", ")
                }
                openedOnce = true
                webSocket.send(PhoneHello.build(prefs, code).toString())
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
                // Nunca conectou neste endereço: o próximo da lista talvez seja o certo (Wi-Fi × cabo × VPN).
                if (!openedOnce && gen == generation && hosts.size > 1) hostIndex++
                scheduleRetry(gen)
            }
        })
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
        // Primeira volta pela lista de endereços: rápido. Depois, backoff normal.
        val cyclingHosts = !openedOnce && hostIndex % hosts.size != 0
        val delay = if (cyclingHosts) 300L else min(30_000L, 1_000L shl min(attempt, 5))
        if (!cyclingHosts) attempt++
        main.post {
            if (gen != generation || closedByUser) return@post
            listener.onDisconnected(true)
            main.removeCallbacks(retryRunnable)
            main.postDelayed(retryRunnable, delay)
        }
    }
}
