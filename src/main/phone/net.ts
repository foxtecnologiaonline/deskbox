import { isIP } from 'net'
import { networkInterfaces } from 'os'

/** Nomes de adaptadores virtuais (VPN, VMs, WSL/Hyper-V, Docker...) — quase nunca é por eles que o celular chega. */
const VIRTUAL_IFACE =
  /virtual|vbox|vmnet|vmware|vethernet|hyper-?v|wsl|docker|^br-|virbr|^veth|tailscale|zerotier|^zt|^tun|^tap|^wg|utun|^bridge|npcap|bluetooth|loopback|^awdl|^llw/i
const PHYSICAL_IFACE = /^(wi-?fi|wlan|wlp|wl\w|en\d|eth|enp|ens|eno|ethernet|wireless|conex)/i

function privateRank(ip: string): number {
  if (ip.startsWith('192.168.56.')) return 3 // rede host-only padrão do VirtualBox
  if (ip.startsWith('192.168.')) return 0
  if (ip.startsWith('10.')) return 1
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2
  return 3
}

/**
 * IPv4 da LAN, do mais provável ao menos provável de ser o Wi-Fi/cabo de verdade: adaptadores físicos
 * primeiro, virtuais (VirtualBox, WSL, Docker, VPN...) por último — antes um adaptador host-only
 * 192.168.56.1 ganhava do Wi-Fi 10.x e o QR mandava o celular para um endereço inalcançável.
 */
export function lanAddresses(): string[] {
  const found: Array<{ ip: string; rank: number }> = []
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue
      const ifaceRank = VIRTUAL_IFACE.test(name) ? 2 : PHYSICAL_IFACE.test(name) ? 0 : 1
      found.push({ ip: info.address, rank: ifaceRank * 10 + privateRank(info.address) })
    }
  }
  return found.sort((a, b) => a.rank - b.rank).map((f) => f.ip)
}

/**
 * Endereço de rede local (mesma regra do app Android, `HostPolicy`): IPv4 privado, link-local, loopback,
 * IPv6 link-local/ULA ou nome `.local`. A conexão reversa só vai a endereços assim — nada sai da LAN.
 */
export function isLocalHost(raw: string): boolean {
  const host = raw.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return false
  if (host === 'localhost') return true
  const kind = isIP(host)
  if (kind === 4) {
    const parts = host.split('.')
    if (parts.some((p) => p.length > 1 && p.startsWith('0'))) return false
    const [a, b] = parts.map(Number)
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  if (kind === 6) {
    if (host === '::1') return true
    const first = parseInt(host.split(':')[0] || '0', 16)
    return (first & 0xffc0) === 0xfe80 || (first & 0xfe00) === 0xfc00
  }
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.local$/.test(host)
}

/** "192.168.0.5", "192.168.0.5:47891", "[fe80::1]:47891", "pixel.local:47891" → host/porta. */
export function parseAddress(raw: string, defaultPort: number): { host: string; port: number } | null {
  const text = raw.trim()
  if (!text) return null
  let host = text
  let port = defaultPort
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(text)
  if (bracket) {
    host = bracket[1]
    if (bracket[2]) port = Number(bracket[2])
  } else if ((text.match(/:/g) ?? []).length === 1) {
    const [h, p] = text.split(':')
    host = h
    if (!/^\d+$/.test(p)) return null
    port = Number(p)
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host, port }
}
