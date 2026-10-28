package app.deskbox.phone

import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONObject
import java.io.InputStream
import java.io.OutputStream
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** Um caminho de sinalização com o Deskbox: o modo direto ([SignalingClient]) ou a conexão reversa ([LinkServer]). */
interface SignalChannel {
    fun send(message: JSONObject): Boolean
    fun close()
}

/** O `hello` que o celular manda ao Deskbox (igual nos dois modos; ver docs/phone-protocol.md). */
object PhoneHello {
    fun build(prefs: Prefs, code: String? = null): JSONObject {
        val hello = JSONObject()
            .put("type", "hello")
            .put("role", "phone")
            .put("deviceId", prefs.deviceId)
            .put("deviceName", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
        if (code != null) {
            // 1º pareamento: só o código. O token antigo (se existir) fica intocado até chegar `paired`.
            hello.put("code", code)
        } else {
            prefs.token?.takeIf { it.isNotEmpty() }?.let { hello.put("token", it) }
        }
        return hello
    }
}

/**
 * Conexão reversa (docs/phone-protocol.md § "Conexão reversa"): o celular escuta e o Deskbox conecta.
 * Existe para quando o firewall do computador bloqueia conexões de entrada — Deskbox portátil sem
 * administrador, ou rede marcada como "Pública" no Windows —, caso em que o modo direto nunca chega lá.
 *
 * TCP com uma mensagem JSON por linha. Quem prova identidade primeiro é o computador: com o código de
 * 6 dígitos que este app mostra (uso único) ou com o segredo que emitimos para ele no 1º pareamento
 * (guardamos só o hash). Depois o celular manda o mesmo `hello` do modo direto e o resto do protocolo é igual.
 * Só fica escutando enquanto o compartilhamento está ativo.
 */
class LinkServer(
    private val prefs: Prefs,
    private val listener: SignalingClient.Listener,
    private val onInfo: (Info?) -> Unit
) : SignalChannel {

    /** O que a tela do app mostra para o usuário digitar no Deskbox. `code` nulo = pareamento por código bloqueado. */
    data class Info(val addresses: List<String>, val port: Int, val code: String?, val linked: Boolean)

    private val main = Handler(Looper.getMainLooper())
    private val random = SecureRandom()
    private val writer: ExecutorService = Executors.newSingleThreadExecutor()
    private val lock = Any()

    @Volatile
    private var server: ServerSocket? = null

    @Volatile
    private var active: Socket? = null

    @Volatile
    private var activeOut: OutputStream? = null

    @Volatile
    private var closed = false

    // Protegidos por [lock].
    private var code: String? = null
    private var badForCode = 0
    private var badTotal = 0
    private val failures = HashMap<String, MutableList<Long>>()

    /** Abre a porta e começa a aceitar o Deskbox. Devolve false se nenhuma porta pôde ser aberta. */
    fun start(): Boolean {
        val socket = openServer() ?: return false
        server = socket
        synchronized(lock) { code = newCode() }
        publish()
        Thread({ acceptLoop(socket) }, "DeskboxLinkAccept").apply { isDaemon = true }.start()
        return true
    }

    fun info(): Info? {
        val socket = server ?: return null
        return Info(localAddresses(), socket.localPort, synchronized(lock) { code }, prefs.linkTokenHash != null)
    }

    override fun send(message: JSONObject): Boolean {
        val out = activeOut ?: return false
        val line = (message.toString() + "\n").toByteArray(Charsets.UTF_8)
        // Escrita fora da thread de quem chama (pode ser a principal: rede na main thread é proibida no Android).
        return try {
            writer.execute {
                try {
                    synchronized(out) {
                        out.write(line)
                        out.flush()
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Falha ao enviar ao Deskbox: ${e.message}")
                }
            }
            true
        } catch (e: Exception) {
            false // executor já encerrado
        }
    }

    override fun close() {
        if (closed) return
        closed = true
        runCatching { server?.close() }
        server = null
        val socket = active
        val out = activeOut
        active = null
        activeOut = null
        // Avisa o Deskbox ("parou de compartilhar") antes de fechar — na thread de escrita, nunca na principal.
        runCatching {
            writer.execute {
                try {
                    if (out != null) {
                        synchronized(out) {
                            out.write("{\"type\":\"bye\"}\n".toByteArray(Charsets.UTF_8))
                            out.flush()
                        }
                    }
                } catch (e: Exception) {
                    // conexão já caiu
                } finally {
                    runCatching { socket?.close() }
                }
            }
        }.onFailure { runCatching { socket?.close() } }
        writer.shutdown()
        main.post { onInfo(null) }
    }

    private fun publish() {
        val info = info()
        main.post { if (!closed) onInfo(info) }
    }

    private fun openServer(): ServerSocket? {
        for (port in DEFAULT_PORT until DEFAULT_PORT + PORT_ATTEMPTS) {
            try {
                return ServerSocket().apply {
                    reuseAddress = true
                    bind(InetSocketAddress(port))
                }
            } catch (e: Exception) {
                // porta ocupada: tenta a próxima
            }
        }
        return null
    }

    private fun acceptLoop(socket: ServerSocket) {
        while (!closed) {
            val client = try {
                socket.accept()
            } catch (e: Exception) {
                if (!closed) Log.w(TAG, "accept falhou: ${e.message}")
                return
            }
            Thread({ handle(client) }, "DeskboxLinkConn").apply { isDaemon = true }.start()
        }
    }

    private fun handle(socket: Socket) {
        val ip = socket.inetAddress?.hostAddress ?: "?"
        var becameActive = false
        try {
            // A porta escuta em todas as interfaces (inclusive dados móveis): só a rede local passa.
            val remote = socket.inetAddress
            if (remote == null || !HostPolicy.isLocalAddress(remote)) return
            socket.tcpNoDelay = true
            socket.soTimeout = HANDSHAKE_TIMEOUT_MS
            val input = socket.getInputStream()
            val out = socket.getOutputStream()
            val write = { json: JSONObject ->
                out.write((json.toString() + "\n").toByteArray(Charsets.UTF_8))
                out.flush()
            }

            val hello = readJson(input) ?: return
            if (hello.optString("type") != "link-hello") return
            when (val auth = authenticate(ip, hello)) {
                is Auth.Fail -> {
                    write(JSONObject().put("type", "error").put("reason", auth.reason))
                    return
                }
                is Auth.Ok -> {
                    val ok = JSONObject().put("type", "link-ok")
                    auth.newSecret?.let { ok.put("linkToken", it) }
                    write(ok)
                }
            }
            write(PhoneHello.build(prefs))

            // Resposta do Deskbox ao nosso hello: `paired` (token novo), `ready` ou `error`.
            val reply = readJson(input) ?: return
            val type = reply.optString("type")
            if (type == "paired") {
                val token = reply.optString("token")
                if (token.isEmpty()) return
                prefs.token = token
            } else if (type != "ready") {
                return
            }

            socket.soTimeout = IDLE_TIMEOUT_MS // o Deskbox manda ping a cada 15 s
            val previous = active
            active = socket
            activeOut = out
            becameActive = true
            runCatching { previous?.close() } // um computador por vez; o novo assume
            publish()
            main.post {
                if (active === socket) {
                    listener.onConnected()
                    listener.onMessage(type, reply)
                }
            }

            while (!closed) {
                val msg = readJson(input) ?: break
                val msgType = msg.optString("type")
                if (msgType == "ping") {
                    send(JSONObject().put("type", "pong"))
                    continue
                }
                if (msgType == "error") break
                main.post { if (active === socket) listener.onMessage(msgType, msg) }
            }
        } catch (e: Exception) {
            if (!closed) Log.i(TAG, "Conexão do Deskbox encerrada: ${e.message}")
        } finally {
            runCatching { socket.close() }
            if (becameActive && active === socket) {
                active = null
                activeOut = null
                main.post { if (!closed) listener.onDisconnected(true) }
            }
        }
    }

    private sealed class Auth {
        data class Ok(val newSecret: String?) : Auth()
        data class Fail(val reason: String) : Auth()
    }

    private fun authenticate(ip: String, hello: JSONObject): Auth {
        synchronized(lock) {
            return authenticateLocked(ip, hello)
        }
    }

    /** Chamado com [lock] tomado. */
    private fun authenticateLocked(ip: String, hello: JSONObject): Auth {
        val now = System.currentTimeMillis()
        // Limpeza ANTES de pegar a lista deste IP (senão ela poderia ser removida do mapa e o erro não contaria).
        if (failures.size > 64) failures.entries.removeAll { (_, times) -> times.all { now - it > FAILURE_WINDOW_MS } }
        val recent = failures.getOrPut(ip) { mutableListOf() }
        recent.removeAll { now - it > FAILURE_WINDOW_MS }

        val secret = hello.optString("linkToken")
        if (secret.isNotEmpty()) {
            val stored = prefs.linkTokenHash
            if (stored != null && constantTimeEquals(sha256(secret), stored)) return Auth.Ok(null)
            recent.add(now)
            return Auth.Fail(if (recent.size >= MAX_FAILURES) "rate_limited" else "bad_token")
        }

        val given = hello.optString("code")
        if (given.isEmpty()) return Auth.Fail("bad_request")
        if (recent.size >= MAX_FAILURES) return Auth.Fail("rate_limited")
        val expected = code ?: return Auth.Fail("expired")
        if (!constantTimeEquals(given, expected)) {
            recent.add(now)
            badForCode++
            badTotal++
            // Poucos chutes por código (depois troca) e um teto por sessão (depois só reiniciando o compartilhamento).
            if (badTotal >= MAX_BAD_PER_SESSION) {
                code = null
            } else if (badForCode >= MAX_BAD_PER_CODE) {
                code = newCode()
                badForCode = 0
            }
            publish()
            return Auth.Fail(if (recent.size >= MAX_FAILURES) "rate_limited" else "bad_code")
        }
        val bytes = ByteArray(32).also { random.nextBytes(it) }
        val newSecret = bytes.joinToString("") { "%02x".format(it) }
        // Um computador por vez: parear com outro invalida o anterior.
        prefs.linkTokenHash = sha256(newSecret)
        code = newCode() // uso único
        badForCode = 0
        publish()
        return Auth.Ok(newSecret)
    }

    private fun newCode(): String = "%06d".format(random.nextInt(1_000_000))

    /** Lê uma linha (até [MAX_LINE_BYTES]) e interpreta como JSON; null no fim do fluxo. */
    private fun readJson(input: InputStream): JSONObject? {
        while (true) {
            val buffer = java.io.ByteArrayOutputStream()
            while (true) {
                val b = input.read()
                if (b == -1) return null
                if (b == '\n'.code) break
                buffer.write(b)
                if (buffer.size() > MAX_LINE_BYTES) throw IllegalStateException("linha grande demais")
            }
            val line = buffer.toString("UTF-8").trim()
            if (line.isEmpty()) continue
            return try {
                JSONObject(line)
            } catch (e: Exception) {
                continue
            }
        }
    }

    companion object {
        private const val TAG = "LinkServer"
        const val DEFAULT_PORT = 47891
        private const val PORT_ATTEMPTS = 10
        private const val HANDSHAKE_TIMEOUT_MS = 10_000
        private const val IDLE_TIMEOUT_MS = 45_000
        private const val MAX_LINE_BYTES = 256 * 1024
        private const val MAX_FAILURES = 5
        private const val FAILURE_WINDOW_MS = 10 * 60 * 1000L
        private const val MAX_BAD_PER_CODE = 10
        private const val MAX_BAD_PER_SESSION = 30

        fun sha256(value: String): String =
            MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

        fun constantTimeEquals(a: String, b: String): Boolean =
            MessageDigest.isEqual(a.toByteArray(Charsets.UTF_8), b.toByteArray(Charsets.UTF_8))

        /** IPv4 de rede local deste celular: Wi-Fi primeiro, depois o hotspot do próprio celular, depois o resto. */
        fun localAddresses(): List<String> = try {
            NetworkInterface.getNetworkInterfaces().toList()
                .filter { it.isUp && !it.isLoopback && !it.isVirtual }
                .sortedBy {
                    when {
                        it.name.startsWith("wlan") -> 0
                        it.name.startsWith("ap") || it.name.startsWith("swlan") -> 1
                        it.name.startsWith("eth") -> 2
                        else -> 3
                    }
                }
                .flatMap { it.inetAddresses.toList() }
                .filterIsInstance<Inet4Address>()
                .filter { !it.isLoopbackAddress && HostPolicy.isLocalAddress(it) }
                .mapNotNull { it.hostAddress }
                .distinct()
        } catch (e: Exception) {
            emptyList()
        }
    }
}
