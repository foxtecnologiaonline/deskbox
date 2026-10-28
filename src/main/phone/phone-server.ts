import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'crypto'
import { createServer, type IncomingMessage, type Server } from 'http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { networkInterfaces } from 'os'
import { dirname } from 'path'
import type { Duplex } from 'stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { PairingInfo, PhoneEvent } from '@shared/types'
import { VIEWER_JS, viewerHtml } from './viewer'

const DEFAULT_PORT = 47890
const PORT_ATTEMPTS = 20
const PAIRING_TTL_MS = 5 * 60 * 1000
const MAX_FAILURES = 5
const MAX_BAD_CODES_PER_PAIRING = 10
const FAILURE_WINDOW_MS = 10 * 60 * 1000
const MAX_MESSAGE_BYTES = 256 * 1024
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

interface PairedPhone {
  deviceId: string
  name: string
  /** SHA-256 do token — o token em si só existe no celular. */
  tokenHash: string
  pairedAt: number
  lastSeenAt: number | null
}

type Json = Record<string, unknown>

/** Só o caminho da requisição, sem `new URL` (que lança com alvos malformados como "//" vindos da rede). */
function requestPath(req: IncomingMessage): string {
  const target = req.url ?? '/'
  const end = target.search(/[?#]/)
  return end === -1 ? target : target.slice(0, end)
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex')
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

/** IPv4 da LAN, privados primeiro (192.168.x → 10.x → 172.16-31.x → resto). */
export function lanAddresses(): string[] {
  const found: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal) found.push(info.address)
    }
  }
  const rank = (ip: string): number => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3)
  return found.sort((a, b) => rank(a) - rank(b))
}

/**
 * Servidor de sinalização do controle de celular (ver docs/phone-protocol.md). Escuta na LAN para o
 * celular e serve o viewer só em loopback. Nada sai da rede local.
 */
export class PhoneServer {
  private http: Server | null = null
  private wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })
  private port = 0
  private starting: Promise<number> | null = null
  /** Chave aleatória por execução: só a página servida em loopback a conhece (protege contra sites no navegador). */
  private viewerKey = randomBytes(32).toString('hex')
  private phones = new Map<string, PairedPhone>()
  private phoneSockets = new Map<string, WebSocket>()
  private viewerSockets = new Map<string, Set<WebSocket>>()
  private pairing: { code: string; expiresAt: number; badCodes: number } | null = null
  private failures = new Map<string, number[]>()

  constructor(
    private file: string,
    private emit: (event: PhoneEvent) => void
  ) {
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return
      const list = JSON.parse(readFileSync(this.file, 'utf-8')) as PairedPhone[]
      for (const phone of list) {
        if (typeof phone.deviceId === 'string' && typeof phone.tokenHash === 'string') this.phones.set(phone.deviceId, phone)
      }
    } catch (error) {
      console.error('[deskbox] Falha ao ler phones.json:', error)
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify([...this.phones.values()], null, 2), 'utf-8')
    } catch (error) {
      console.error('[deskbox] Falha ao salvar phones.json:', error)
    }
  }

  hasPairedPhones(): boolean {
    return this.phones.size > 0
  }

  isPaired(deviceId: string): boolean {
    return this.phones.has(deviceId)
  }

  phoneName(deviceId: string): string | null {
    return this.phones.get(deviceId)?.name ?? null
  }

  /** Sobe o servidor (idempotente) e devolve a porta efetiva. */
  ensureStarted(): Promise<number> {
    if (this.port) return Promise.resolve(this.port)
    if (this.starting) return this.starting
    this.starting = new Promise<number>((resolve, reject) => {
      const tryListen = (port: number, attemptsLeft: number): void => {
        const server = createServer((req, res) => {
          try {
            this.handleHttp(req, res)
          } catch (error) {
            console.error('[deskbox] Falha numa requisição ao servidor do celular:', error)
            if (!res.headersSent) res.writeHead(500)
            res.end()
          }
        })
        server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head))
        server.on('clientError', (_error, socket) => socket.destroy())
        server.once('error', (error: NodeJS.ErrnoException) => {
          server.close()
          if (error.code === 'EADDRINUSE' && attemptsLeft > 0) tryListen(port + 1, attemptsLeft - 1)
          else reject(error)
        })
        server.listen(port, '0.0.0.0', () => {
          this.http = server
          this.port = port
          resolve(port)
        })
      }
      tryListen(DEFAULT_PORT, PORT_ATTEMPTS)
    })
    this.starting.catch(() => {
      this.starting = null
    })
    return this.starting
  }

  async viewerUrl(deviceId: string): Promise<string> {
    const port = await this.ensureStarted()
    return `http://127.0.0.1:${port}/viewer/${encodeURIComponent(deviceId)}`
  }

  async startPairing(): Promise<PairingInfo> {
    const port = await this.ensureStarted()
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const expiresAt = Date.now() + PAIRING_TTL_MS
    this.pairing = { code, expiresAt, badCodes: 0 }
    const hosts = lanAddresses()
    const host = hosts[0] ?? '127.0.0.1'
    return { code, expiresAt, port, hosts, uri: `deskbox://pair?host=${host}&port=${port}&code=${code}` }
  }

  cancelPairing(): void {
    this.pairing = null
  }

  /** Esquece um celular: invalida o token e derruba a conexão. */
  forget(deviceId: string): void {
    if (!this.phones.delete(deviceId)) return
    this.save()
    this.phoneSockets.get(deviceId)?.close(4000, 'forgotten')
    this.phoneSockets.delete(deviceId)
    for (const viewer of this.viewerSockets.get(deviceId) ?? []) this.send(viewer, { type: 'phone-offline' })
  }

  dispose(): void {
    for (const ws of this.phoneSockets.values()) ws.close()
    for (const set of this.viewerSockets.values()) for (const ws of set) ws.close()
    this.http?.close()
    this.http = null
    this.port = 0
    this.starting = null
  }

  // ---------- HTTP (viewer, somente loopback) ----------

  private isLoopbackRequest(req: IncomingMessage): boolean {
    const remote = req.socket.remoteAddress ?? ''
    if (!LOOPBACK.has(remote)) return false
    // Anti DNS-rebinding: o Host tem que ser literalmente o loopback com a nossa porta.
    const host = req.headers.host ?? ''
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`
  }

  private handleHttp(req: IncomingMessage, res: import('http').ServerResponse): void {
    const deny = (status: number): void => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(status === 404 ? 'Not found' : 'Forbidden')
    }
    if (!this.isLoopbackRequest(req)) return deny(403)
    const pathname = requestPath(req)
    const headers = {
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff'
    }
    if (pathname === '/viewer.js') {
      res.writeHead(200, { ...headers, 'Content-Type': 'text/javascript; charset=utf-8' })
      return void res.end(VIEWER_JS)
    }
    const match = /^\/viewer\/([^/]+)$/.exec(pathname)
    if (match) {
      const deviceId = safeDecode(match[1])
      if (deviceId === null || !this.phones.has(deviceId)) return deny(404)
      res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' })
      return void res.end(viewerHtml(deviceId, this.viewerKey, this.port))
    }
    deny(404)
  }

  // ---------- WebSocket (/signal) ----------

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    // Este servidor escuta na LAN: nada que vem do cliente pode lançar exceção aqui (uma exceção
    // não tratada derrubaria o processo principal do app inteiro).
    socket.on('error', () => socket.destroy())
    try {
      if (requestPath(req) !== '/signal') {
        socket.destroy()
        return
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req))
    } catch (error) {
      console.error('[deskbox] Falha no upgrade do WebSocket do celular:', error)
      socket.destroy()
    }
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const ip = req.socket.remoteAddress ?? 'unknown'
    const loopback = this.isLoopbackRequest(req)
    // O viewer legítimo é uma página servida por nós, então o Origin tem que ser exatamente o nosso.
    // Sites comuns abrindo ws://127.0.0.1 teriam outro Origin (e não conhecem a chave).
    const originOk = req.headers.origin === `http://127.0.0.1:${this.port}`
    let role: 'phone' | 'viewer' | null = null
    let deviceId: string | null = null
    let alive = true

    const helloTimeout = setTimeout(() => {
      if (!role) ws.close(4001, 'hello timeout')
    }, 10_000)
    const ping = setInterval(() => {
      if (!alive) return ws.terminate()
      alive = false
      ws.ping()
    }, 15_000)
    ws.on('pong', () => (alive = true))

    ws.on('message', (data, isBinary) => {
      try {
        handleMessage(data, isBinary)
      } catch (error) {
        console.error('[deskbox] Falha ao tratar mensagem do celular/viewer:', error)
        ws.terminate()
      }
    })

    const handleMessage = (data: import('ws').RawData, isBinary: boolean): void => {
      if (isBinary) return
      let msg: Json
      try {
        msg = JSON.parse(data.toString('utf-8')) as Json
      } catch {
        return
      }
      if (typeof msg.type !== 'string') return

      if (!role) {
        if (msg.type !== 'hello') return this.fail(ws, 'bad_request')
        if (msg.role === 'viewer') {
          const keyOk = typeof msg.key === 'string' && safeEqual(msg.key, this.viewerKey)
          if (!(loopback && originOk && keyOk) || typeof msg.deviceId !== 'string' || !this.phones.has(msg.deviceId)) {
            return this.fail(ws, 'bad_request')
          }
          role = 'viewer'
          deviceId = msg.deviceId
          let set = this.viewerSockets.get(deviceId)
          if (!set) this.viewerSockets.set(deviceId, (set = new Set()))
          set.add(ws)
          this.send(ws, { type: this.phoneSockets.has(deviceId) ? 'phone-online' : 'phone-offline' })
          return
        }
        if (msg.role === 'phone') {
          const auth = this.authenticatePhone(ip, msg)
          if (!auth.ok) return this.fail(ws, auth.reason)
          role = 'phone'
          deviceId = auth.deviceId
          const previous = this.phoneSockets.get(deviceId)
          this.phoneSockets.set(deviceId, ws)
          previous?.close(4002, 'replaced')
          const phone = this.phones.get(deviceId)!
          phone.lastSeenAt = Date.now()
          this.save()
          this.send(ws, auth.token ? { type: 'paired', token: auth.token } : { type: 'ready' })
          for (const viewer of this.viewerSockets.get(deviceId) ?? []) this.send(viewer, { type: 'phone-online' })
          this.emit({ type: 'online', deviceId, name: phone.name })
          return
        }
        return this.fail(ws, 'bad_request')
      }

      // Já autenticado: só repassa mensagens de sinalização entre celular e viewer do mesmo deviceId.
      if (!deviceId) return
      if (role === 'phone' && ['offer', 'ice', 'bye'].includes(msg.type)) {
        for (const viewer of this.viewerSockets.get(deviceId) ?? []) this.send(viewer, msg)
      } else if (role === 'viewer' && ['start', 'answer', 'ice', 'stop'].includes(msg.type)) {
        const phoneSocket = this.phoneSockets.get(deviceId)
        if (phoneSocket) this.send(phoneSocket, msg)
      }
    }

    ws.on('close', () => {
      clearTimeout(helloTimeout)
      clearInterval(ping)
      if (!deviceId) return
      if (role === 'phone' && this.phoneSockets.get(deviceId) === ws) {
        this.phoneSockets.delete(deviceId)
        for (const viewer of this.viewerSockets.get(deviceId) ?? []) this.send(viewer, { type: 'phone-offline' })
        this.emit({ type: 'offline', deviceId, name: this.phones.get(deviceId)?.name ?? '' })
      } else if (role === 'viewer') {
        this.viewerSockets.get(deviceId)?.delete(ws)
        // Sem viewers, manda o celular parar de transmitir (economiza bateria/banda).
        if (!this.viewerSockets.get(deviceId)?.size) {
          const phoneSocket = this.phoneSockets.get(deviceId)
          if (phoneSocket) this.send(phoneSocket, { type: 'stop' })
        }
      }
    })
    ws.on('error', () => undefined)
  }

  private authenticatePhone(
    ip: string,
    msg: Json
  ): { ok: true; deviceId: string; token?: string } | { ok: false; reason: string } {
    if (typeof msg.deviceId !== 'string' || msg.deviceId.length < 8 || msg.deviceId.length > 64) {
      return { ok: false, reason: 'bad_request' }
    }
    const deviceId = msg.deviceId
    const deviceName = typeof msg.deviceName === 'string' ? msg.deviceName.slice(0, 60) : 'Celular Android'

    if (typeof msg.token === 'string') {
      const phone = this.phones.get(deviceId)
      if (phone && safeEqual(sha256(msg.token), phone.tokenHash)) return { ok: true, deviceId }
      this.recordFailure(ip)
      return { ok: false, reason: this.isRateLimited(ip) ? 'rate_limited' : 'bad_token' }
    }

    if (typeof msg.code === 'string') {
      if (this.isRateLimited(ip)) return { ok: false, reason: 'rate_limited' }
      const pairing = this.pairing
      if (!pairing || Date.now() > pairing.expiresAt) {
        this.pairing = null
        return { ok: false, reason: 'expired' }
      }
      if (!safeEqual(msg.code, pairing.code)) {
        this.recordFailure(ip)
        // Limite global por código: além do limite por IP (que muitos endereços contornariam), o código
        // inteiro é invalidado depois de poucas tentativas erradas, de qualquer origem.
        if (++pairing.badCodes >= MAX_BAD_CODES_PER_PAIRING) this.pairing = null
        return { ok: false, reason: this.isRateLimited(ip) ? 'rate_limited' : 'bad_code' }
      }
      this.pairing = null
      const token = randomBytes(32).toString('hex')
      this.phones.set(deviceId, {
        deviceId,
        name: deviceName,
        tokenHash: sha256(token),
        pairedAt: Date.now(),
        lastSeenAt: Date.now()
      })
      this.save()
      this.emit({ type: 'paired', deviceId, name: deviceName })
      return { ok: true, deviceId, token }
    }
    return { ok: false, reason: 'bad_request' }
  }

  private recordFailure(ip: string): void {
    const now = Date.now()
    const recent = (this.failures.get(ip) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS)
    recent.push(now)
    this.failures.set(ip, recent)
    if (this.failures.size > 256) {
      for (const [key, times] of this.failures) {
        if (times.every((t) => now - t >= FAILURE_WINDOW_MS)) this.failures.delete(key)
      }
    }
  }

  private isRateLimited(ip: string): boolean {
    const now = Date.now()
    return (this.failures.get(ip) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS).length >= MAX_FAILURES
  }

  private send(ws: WebSocket, msg: Json): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  }

  private fail(ws: WebSocket, reason: string): void {
    this.send(ws, { type: 'error', reason })
    ws.close(4003, reason)
  }

  /** Para testes: um id novo e válido. */
  static newDeviceId(): string {
    return randomUUID()
  }
}
