package app.deskbox.phone

import java.net.InetAddress
import java.net.UnknownHostException

/**
 * A sinalização é ws:// (sem TLS) e carrega o código/token de pareamento: o app só conecta em endereços de
 * rede local, para que um QR/digitação errada nunca mande esses dados a um host da internet.
 */
object HostPolicy {
    const val MESSAGE = "Use o endereço da rede local mostrado no Deskbox (ex.: 192.168.0.10)."

    private val IPV4 = Regex("""^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$""")
    private val MDNS_NAME = Regex("""^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.local$""")
    private val IPV6 = Regex("""^[0-9a-f:]+$""")

    /** Aceita IPv4 privado (10/8, 172.16/12, 192.168/16), link-local 169.254/16, loopback, IPv6 local e nomes `.local`. */
    fun isLocalHost(rawHost: String): Boolean {
        val host = rawHost.trim().lowercase().removePrefix("[").removeSuffix("]")
        if (host.isEmpty()) return false
        if (host == "localhost") return true
        if (host.contains(':')) return isLocalIpv6(host)
        val octets = IPV4.matchEntire(host)?.groupValues?.drop(1)
        if (octets != null) return isLocalIpv4(octets)
        return MDNS_NAME.matches(host)
    }

    private fun isLocalIpv4(parts: List<String>): Boolean {
        // Rejeita formas ambíguas ("010.0.0.1" é octal em alguns parsers).
        if (parts.any { it.length > 1 && it.startsWith("0") }) return false
        val n = parts.map { it.toInt() }
        if (n.any { it > 255 }) return false
        return n[0] == 10 ||
            n[0] == 127 ||
            (n[0] == 172 && n[1] in 16..31) ||
            (n[0] == 192 && n[1] == 168) ||
            (n[0] == 169 && n[1] == 254)
    }

    private fun isLocalIpv6(host: String): Boolean {
        if (!IPV6.matches(host)) return false
        if (host == "::1") return true
        val first = host.substringBefore(':')
        if (first.isEmpty() || first.length > 4) return false
        val value = first.toInt(16)
        return (value and 0xffc0) == 0xfe80 || (value and 0xfe00) == 0xfc00 // link-local ou ULA
    }

    /** Checagem de camada de rede: o endereço RESOLVIDO também precisa ser local (cobre `.local` que resolve para fora). */
    fun isLocalAddress(address: InetAddress): Boolean {
        if (address.isLoopbackAddress || address.isLinkLocalAddress || address.isSiteLocalAddress) return true
        val bytes = address.address
        return bytes.size == 16 && (bytes[0].toInt() and 0xfe) == 0xfc // ULA fc00::/7
    }

    /** DNS que só devolve endereços locais — ou falha. Usado pelo OkHttp antes de qualquer conexão. */
    val localOnlyDns: okhttp3.Dns = object : okhttp3.Dns {
        override fun lookup(hostname: String): List<InetAddress> {
            val local = okhttp3.Dns.SYSTEM.lookup(hostname).filter { isLocalAddress(it) }
            if (local.isEmpty()) throw UnknownHostException("$hostname não resolve para um endereço de rede local")
            return local
        }
    }
}
