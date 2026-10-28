import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { connect as netConnect, type Socket } from 'net'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { hostname } from 'os'
import { dirname } from 'path'
import type { Duplex } from 'stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { PairingInfo, PhoneEvent, PhoneLinkResult } from '@shared/types'
import { VIEWER_JS, viewerHtml } from './viewer'
import { isLocalHost, lanAddresses, parseAddress } from './net'

export { lanAddresses } from './net'

const LAN_DEFAULT_PORT = 47890
/** Porta em que o app do celular escuta a conexão reversa (Deskbox → celular). */
export const LINK_DEFAULT_PORT = 47891
const PORT_ATTEMPTS = 20
const PAIRING_TTL_MS = 5 * 60 * 1000
const MAX_FAILURES = 5
const MAX_BAD_CODES_PER_PAIRING = 10
const FAILURE_WINDOW_MS = 10 * 60 * 1000
const MAX_MESSAGE_BYTES = 256 * 1024
const PING_MS = 15_000
const LINK_CONNECT_TIMEOUT_MS = 4000
const LINK_HANDSHAKE_TIMEOUT_MS = 10_000
/** Com o viewer aberto tenta religar rápido; sem ninguém olhando, bem de vez em quando. */
const LINK_RETRY_WATCHED_MS = 3000
const LINK_RETRY_IDLE_MS = 20_000
const LINK_TICK_MS = 1000
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

interface PhoneLink {
  host: string
  port: number
  /** Segredo que o celular emitiu para este computador (protegido pelo cofre do SO quando disponível). */
  secret: string
}

interface PairedPhone {
  deviceId: string
  name: string
  /** SHA-256 do token — o token em si só existe no celular. */
  tokenHash: string
  pairedAt: number
  lastSeenAt: number | null
  /** Presente quando quem abre a conexão é o Deskbox (conexão reversa). */
  link?: PhoneLink
}

/** Protege o segredo da conexão reversa em disco (no app: safeStorage; nos testes: identidade). */
export interface SecretBox {
  seal(value: string): string
  open(sealed: string): string | null
}

const plainBox: SecretBox = {
  seal: (value) => `plain:${value}`,
  open: (sealed) => (sealed.startsWith('plain:') ? sealed.slice(6) : null)
}

type Json = Record<string, unknown>

/** Um celular autenticado, venha por WebSocket (ele conectou em nós) ou por TCP (nós conectamos nele). */
interface PhoneChannel {
  send(msg: Json): void
  close(reason: string): void
}

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

function validDeviceId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 64
}

function deviceNameOf(msg: Json): string {
  return typeof msg.deviceName === 'string' && msg.deviceName.trim() ? msg.deviceName.slice(0, 60) : 'Celular Android'
}

function listen(server: Server, host: string, firstPort: number, attempts: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (port: number, left: number): void => {
      const onError = (error: NodeJS.ErrnoException): void => {
        if (error.code === 'EADDRINUSE' && left > 0 && firstPort !== 0) tryPort(port + 1, left - 1)
        else reject(error)
      }
      server.once('error', onError)
      server.listen(port, host, () => {
        server.off('error', onError)
        const address = server.address()
        resolve(typeof address === 'object' && address ? address.port : port)
      })
    }
    tryPort(firstPort, attempts)
  })
}

/**
 * Controle de celular (ver docs/phone-protocol.md). Dois servidores separados:
 * - **viewer** (127.0.0.1, porta livre): a página que o BrowserView carrega e o WebSocket dela. Loopback
 *   não aciona o firewall do Windows.
 * - **LAN** (0.0.0.0:47890): onde o celular conecta no modo direto. Só sobe quando precisa (pareamento
 *   pelo QR ou celular pareado nesse modo) — é ele que faz o Windows pedir permissão de firewall.
 * E a **conexão reversa**: o Deskbox conecta no celular (TCP, JSON por linha). Funciona mesmo quando o
 * firewall bloqueia conexões de entrada no computador (Deskbox portátil sem admin, rede "Pública").
 */
export class PhoneServer {
  private viewerHttp: Server | null = null
  private viewerPort = 0
  private viewerStarting: Promise<number> | null = null
  private lanHttp: Server | null = null
  private lanPort = 0
  private lanStarting: Promise<number> | null = null
  private wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })
  /** Chave aleatória por execução: só a página servida em loopback a conhece (protege contra sites no navegador). */
  private viewerKey = randomBytes(32).toString('hex')
  private phones = new Map<string, PairedPhone>()
  private phoneChannels = new Map<string, PhoneChannel>()
  private viewerSockets = new Map<string, Set<WebSocket>>()
  private pairing: { code: string; expiresAt: number; badCodes: number } | null = null
  private failures = new Map<string, number[]>()
  private linkTimer: NodeJS.Timeout | null = null
  private linkAttemptAt = new Map<string, number>()
  private linking = new Set<string>()
  private linkSockets = new Set<Socket>()
  private disposed = false

  constructor(
    private file: string,
    private emit: (event: PhoneEvent) => void,
    private box: SecretBox = plainBox
  ) {
    this.load()
    this.ensureLinkLoop()
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return
      const list = JSON.parse(readFileSync(this.file, 'utf-8')) as PairedPhone[]
      for (const phone of list) {
        if (typeof phone.deviceId !== 'string' || typeof phone.tokenHash !== 'string') continue
        const link = phone.link
        if (link && !(typeof link.host === 'string' && Number.isInteger(link.port) && typeof link.secret === 'string')) {
          delete phone.link
        }
        this.phones.set(phone.deviceId, phone)
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

  /** Celulares que conectam por conta própria no servidor LAN (modo direto). */
  hasDirectPhones(): boolean {
    return [...this.phones.values()].some((p) => !p.link)
  }

  isPaired(deviceId: string): boolean {
    return this.phones.has(deviceId)
  }

  phoneName(deviceId: string): string | null {
    return this.phones.get(deviceId)?.name ?? null
  }

  private makeServer(kind: 'viewer' | 'lan'): Server {
    const server = createServer((req, res) => {
      try {
        if (kind === 'viewer') this.handleViewerHttp(req, res)
        else {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('Not found')
        }
      } catch (error) {
        console.error('[deskbox] Falha numa requisição ao servidor do celular:', error)
        if (!res.headersSent) res.writeHead(500)
        res.end()
      }
    })
    server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head, kind))
    server.on('clientError', (_error, socket) => socket.destroy())
    return server
  }

  /** Servidor do viewer (só loopback). Idempotente. */
  ensureViewerServer(): Promise<number> {
    if (this.viewerPort) return Promise.resolve(this.viewerPort)
    if (this.viewerStarting) return this.viewerStarting
    const server = this.makeServer('viewer')
    this.viewerStarting = listen(server, '127.0.0.1', 0, 0).then((port) => {
      this.viewerHttp = server
      this.viewerPort = port
      return port
    })
    this.viewerStarting.catch(() => {
      this.viewerStarting = null
    })
    return this.viewerStarting
  }

  /** Servidor LAN do modo direto (celular → Deskbox). Idempotente. */
  ensureLanServer(): Promise<number> {
    if (this.lanPort) return Promise.resolve(this.lanPort)
    if (this.lanStarting) return this.lanStarting
    const server = this.makeServer('lan')
    this.lanStarting = listen(server, '0.0.0.0', LAN_DEFAULT_PORT, PORT_ATTEMPTS).then((port) => {
      this.lanHttp = server
      this.lanPort = port
      return port
    })
    this.lanStarting.catch(() => {
      this.lanStarting = null
    })
    return this.lanStarting
  }

  async viewerUrl(deviceId: string): Promise<string> {
    const port = await this.ensureViewerServer()
    return `http://127.0.0.1:${port}/viewer/${encodeURIComponent(deviceId)}`
  }

  async startPairing(): Promise<PairingInfo> {
    const port = await this.ensureLanServer()
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const expiresAt = Date.now() + PAIRING_TTL_MS
    this.pairing = { code, expiresAt, badCodes: 0 }
    const hosts = lanAddresses()
    const host = hosts[0] ?? '127.0.0.1'
    // `host` continua sendo o principal (apps antigos só leem ele); `alt` lista os outros endereços, que o app
    // tenta em seguida — cobre o PC com Wi-Fi + cabo, VPN ou VM em que o 1º palpite não é o certo.
    const alt = hosts.slice(1, 4)
    const uri = `deskbox://pair?host=${host}&port=${port}&code=${code}${alt.length ? `&alt=${alt.join(',')}` : ''}`
    return { code, expiresAt, port, hosts, uri }
  }

  cancelPairing(): void {
    this.pairing = null
  }

  /** Esquece um celular: invalida o token e derruba a conexão. */
  forget(deviceId: string): void {
    if (!this.phones.delete(deviceId)) return
    this.save()
    const channel = this.phoneChannels.get(deviceId)
    this.phoneChannels.delete(deviceId)
    channel?.close('forgotten')
    for (const viewer of this.viewerSockets.get(deviceId) ?? []) this.send(viewer, { type: 'phone-offline' })
  }

  dispose(): void {
    this.disposed = true
    if (this.linkTimer) clearInterval(this.linkTimer)
    this.linkTimer = null
    for (const channel of this.phoneChannels.values()) channel.close('shutdown')
    this.phoneChannels.clear()
    for (const socket of this.linkSockets) socket.destroy()
    for (const set of this.viewerSockets.values()) for (const ws of set) ws.close()
    this.viewerHttp?.close()
    this.lanHttp?.close()
    this.viewerHttp = null
    this.lanHttp = null
    this.viewerPort = 0
    this.lanPort = 0
    this.viewerStarting = null
    this.lanStarting = null
  }

  // ---------- celular autenticado (qualquer transporte) ----------

  private attachPhone(channel: PhoneChannel, deviceId: string): void {
    const previous = this.phoneChannels.get(deviceId)
    this.phoneChannels.set(deviceId, channel)
    if (previous && previous !== channel) previous.close('replaced')
    const phone = this.phones.get(deviceId)!
    phone.lastSeenAt = Date.now()
    this.save()
    for (const viewer of this.viewerSockets.get(deviceId) ?? []) this.send(viewer, { type: 'phone-online' })
    this.emit({ type: 'online', deviceId, name: phone.name })
  }

  private detachPhone(channel: PhoneChannel, deviceId: string): void {
    if (this.phoneChannels.get(deviceId) !== channel) return
    this.phoneChannels.delete(deviceId)
    for (const viewer of this.viewerSockets.get(deviceId) ?? []) this.send(viewer, { type: 'phone-offline' })
    this.emit({ type: 'offline', deviceId, name: this.phones.get(deviceId)?.name ?? '' })
  }

  /** Celular → viewers do mesmo aparelho (só mensagens de sinalização). */
  private relayFromPhone(deviceId: string, msg: Json): void {
    if (!['offer', 'ice', 'bye'].includes(msg.type as string)) return
    for (const viewer of this.viewerSockets.get(deviceId) ?? []) this.send(viewer, msg)
  }

  private issueToken(deviceId: string, name: string, link?: PhoneLink): string {
    const token = randomBytes(32).toString('hex')
    this.phones.set(deviceId, { deviceId, name, tokenHash: sha256(token), pairedAt: Date.now(), lastSeenAt: Date.now(), link })
    this.save()
    return token
  }

  // ---------- HTTP do viewer (somente loopback) ----------

  private isLoopbackRequest(req: IncomingMessage): boolean {
    const remote = req.socket.remoteAddress ?? ''
    if (!LOOPBACK.has(remote)) return false
    // Anti DNS-rebinding: o Host tem que ser literalmente o loopback com a porta do viewer.
    const host = req.headers.host ?? ''
    return host === `127.0.0.1:${this.viewerPort}` || host === `localhost:${this.viewerPort}`
  }

  private handleViewerHttp(req: IncomingMessage, res: ServerResponse): void {
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
      return void res.end(viewerHtml(deviceId, this.viewerKey, this.viewerPort))
    }
    deny(404)
  }

  // ---------- WebSocket (/signal) ----------

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, kind: 'viewer' | 'lan'): void {
    // O servidor LAN é exposto à rede: nada que vem do cliente pode lançar exceção aqui (uma exceção
    // não tratada derrubaria o processo principal do app inteiro).
    socket.on('error', () => socket.destroy())
    try {
      if (requestPath(req) !== '/signal') {
        socket.destroy()
        return
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req, kind))
    } catch (error) {
      console.error('[deskbox] Falha no upgrade do WebSocket do celular:', error)
      socket.destroy()
    }
  }

  private onConnection(ws: WebSocket, req: IncomingMessage, kind: 'viewer' | 'lan'): void {
    const ip = req.socket.remoteAddress ?? 'unknown'
    // O viewer legítimo é uma página servida por nós, então o Origin tem que ser exatamente o nosso.
    // Sites comuns abrindo ws://127.0.0.1 teriam outro Origin (e não conhecem a chave).
    const viewerAllowed = kind === 'viewer' && this.isLoopbackRequest(req) && req.headers.origin === `http://127.0.0.1:${this.viewerPort}`
    let role: 'phone' | 'viewer' | null = null
    let deviceId: string | null = null
    let alive = true
    const channel: PhoneChannel = {
      send: (msg) => this.send(ws, msg),
      close: (reason) => ws.close(reason === 'forgotten' ? 4000 : 4002, reason)
    }

    const helloTimeout = setTimeout(() => {
      if (!role) ws.close(4001, 'hello timeout')
    }, 10_000)
    const ping = setInterval(() => {
      if (!alive) return ws.terminate()
      alive = false
      ws.ping()
    }, PING_MS)
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
      if (!msg || typeof msg.type !== 'string') return

      if (!role) {
        if (msg.type !== 'hello') return this.fail(ws, 'bad_request')
        if (msg.role === 'viewer' && kind === 'viewer') {
          const keyOk = typeof msg.key === 'string' && safeEqual(msg.key, this.viewerKey)
          if (!(viewerAllowed && keyOk) || typeof msg.deviceId !== 'string' || !this.phones.has(msg.deviceId)) {
            return this.fail(ws, 'bad_request')
          }
          role = 'viewer'
          deviceId = msg.deviceId
          let set = this.viewerSockets.get(deviceId)
          if (!set) this.viewerSockets.set(deviceId, (set = new Set()))
          set.add(ws)
          this.send(ws, { type: this.phoneChannels.has(deviceId) ? 'phone-online' : 'phone-offline' })
          if (!this.phoneChannels.has(deviceId)) this.nudgeLink(deviceId)
          return
        }
        if (msg.role === 'phone' && kind === 'lan') {
          const auth = this.authenticatePhone(ip, msg)
          if (!auth.ok) return this.fail(ws, auth.reason)
          role = 'phone'
          deviceId = auth.deviceId
          this.send(ws, auth.token ? { type: 'paired', token: auth.token } : { type: 'ready' })
          this.attachPhone(channel, deviceId)
          return
        }
        return this.fail(ws, 'bad_request')
      }

      // Já autenticado: só repassa mensagens de sinalização entre celular e viewer do mesmo deviceId.
      if (!deviceId) return
      if (role === 'phone') this.relayFromPhone(deviceId, msg)
      else if (role === 'viewer' && ['start', 'answer', 'ice', 'stop'].includes(msg.type)) {
        this.phoneChannels.get(deviceId)?.send(msg)
      }
    }

    ws.on('close', () => {
      clearTimeout(helloTimeout)
      clearInterval(ping)
      if (!deviceId) return
      if (role === 'phone') this.detachPhone(channel, deviceId)
      else if (role === 'viewer') {
        this.viewerSockets.get(deviceId)?.delete(ws)
        // Sem viewers, manda o celular parar de transmitir (economiza bateria/banda).
        if (!this.viewerSockets.get(deviceId)?.size) this.phoneChannels.get(deviceId)?.send({ type: 'stop' })
      }
    })
    ws.on('error', () => undefined)
  }

  private authenticatePhone(
    ip: string,
    msg: Json
  ): { ok: true; deviceId: string; token?: string } | { ok: false; reason: string } {
    if (!validDeviceId(msg.deviceId)) return { ok: false, reason: 'bad_request' }
    const deviceId = msg.deviceId

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
      const name = deviceNameOf(msg)
      const token = this.issueToken(deviceId, name)
      this.emit({ type: 'paired', deviceId, name })
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

  // ---------- conexão reversa (Deskbox → celular) ----------

  /**
   * Pareia conectando no celular: o usuário digita aqui o endereço e o código que o app mostra. Quem prova
   * identidade primeiro é o computador (código de uso único do celular); depois o celular se apresenta e
   * recebe um token nosso, como no modo direto. Daí em diante o Deskbox religa sozinho com o segredo que o
   * celular emitiu (`link.secret`).
   */
  async linkPhone(address: string, code: string): Promise<PhoneLinkResult> {
    const target = parseAddress(address, LINK_DEFAULT_PORT)
    if (!target) return { ok: false, error: 'Endereço inválido. Use o que aparece no app, ex.: 192.168.0.23:47891.' }
    if (!isLocalHost(target.host)) {
      return { ok: false, error: 'Use um endereço da rede local (ex.: 192.168.x.x) — o controle não sai da sua rede.' }
    }
    const trimmed = code.trim()
    if (!/^\d{6}$/.test(trimmed)) return { ok: false, error: 'O código tem 6 dígitos (aparece no app do celular).' }
    return this.openLink(target, { code: trimmed })
  }

  private ensureLinkLoop(): void {
    if (this.linkTimer || this.disposed) return
    if (![...this.phones.values()].some((p) => p.link)) return
    this.linkTimer = setInterval(() => this.tickLinks(), LINK_TICK_MS)
    this.linkTimer.unref?.()
  }

  /** Viewer de um celular de conexão reversa abriu: tenta já, sem esperar o próximo ciclo. */
  private nudgeLink(deviceId: string): void {
    if (!this.phones.get(deviceId)?.link) return
    this.linkAttemptAt.delete(deviceId)
    this.tickLinks()
  }

  private tickLinks(): void {
    const now = Date.now()
    for (const phone of this.phones.values()) {
      const { deviceId, link } = phone
      if (!link || this.phoneChannels.has(deviceId) || this.linking.has(deviceId)) continue
      const watched = (this.viewerSockets.get(deviceId)?.size ?? 0) > 0
      const wait = watched ? LINK_RETRY_WATCHED_MS : LINK_RETRY_IDLE_MS
      if (now - (this.linkAttemptAt.get(deviceId) ?? 0) < wait) continue
      const secret = this.box.open(link.secret)
      if (!secret) continue
      this.linkAttemptAt.set(deviceId, now)
      this.linking.add(deviceId)
      void this.openLink({ host: link.host, port: link.port }, { deviceId, secret }).finally(() => this.linking.delete(deviceId))
    }
  }

  private openLink(
    target: { host: string; port: number },
    auth: { code: string } | { deviceId: string; secret: string }
  ): Promise<PhoneLinkResult> {
    return new Promise((resolve) => {
      if (this.disposed) return resolve({ ok: false, error: 'Encerrando.' })
      const socket = netConnect({ host: target.host, port: target.port })
      this.linkSockets.add(socket)
      let settled = false
      let stage: 'link' | 'hello' | 'linked' = 'link'
      let issuedSecret: string | null = null
      let deviceId: string | null = null
      let buffer = ''
      let alive = true
      let ping: NodeJS.Timeout | null = null
      const channel: PhoneChannel = {
        send: (msg) => {
          if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(msg)}\n`)
        },
        close: () => socket.destroy()
      }
      const finish = (result: PhoneLinkResult): void => {
        if (settled) return
        settled = true
        resolve(result)
      }
      let ended = false
      const abort = (error: string, reason?: string): void => {
        ended = true
        finish({ ok: false, error })
        if (reason && !socket.destroyed) {
          // end() entrega o erro antes de fechar (destroy() descartaria o que ainda está no buffer).
          socket.end(`${JSON.stringify({ type: 'error', reason })}\n`)
          setTimeout(() => socket.destroy(), 500).unref?.()
        } else socket.destroy()
      }

      socket.setNoDelay(true)
      socket.setKeepAlive(true, PING_MS)
      socket.setTimeout(LINK_CONNECT_TIMEOUT_MS)
      const handshakeTimer = setTimeout(() => {
        if (stage !== 'linked') abort('O celular não respondeu. Confira o endereço e se o compartilhamento está ativo no app.')
      }, LINK_HANDSHAKE_TIMEOUT_MS)

      socket.on('timeout', () => {
        if (stage !== 'linked') abort('Sem resposta do celular. Confira o endereço, a rede Wi-Fi e se o compartilhamento está ativo no app.')
      })
      socket.on('error', (error: NodeJS.ErrnoException) => {
        const text =
          error.code === 'ECONNREFUSED'
            ? 'O celular recusou a conexão: toque em "Iniciar compartilhamento" no app e confira a porta.'
            : error.code === 'EHOSTUNREACH' || error.code === 'ENETUNREACH' || error.code === 'ETIMEDOUT'
              ? 'Celular inalcançável: confira se está no mesmo Wi-Fi que este computador.'
              : `Falha na conexão com o celular (${error.code ?? error.message}).`
        finish({ ok: false, error: text })
      })
      socket.on('close', () => {
        clearTimeout(handshakeTimer)
        if (ping) clearInterval(ping)
        this.linkSockets.delete(socket)
        if (stage === 'linked' && deviceId) this.detachPhone(channel, deviceId)
        finish({ ok: false, error: 'O celular encerrou a conexão.' })
      })
      socket.on('connect', () => {
        const hello: Json = { type: 'link-hello', desktopName: hostname().slice(0, 60) }
        if ('code' in auth) hello.code = auth.code
        else hello.linkToken = auth.secret
        channel.send(hello)
      })

      const onMessage = (msg: Json): void => {
        if (stage === 'link') {
          if (msg.type === 'error') {
            const reason = String(msg.reason ?? '')
            if ('deviceId' in auth && reason === 'bad_token') {
              // O celular não reconhece mais este computador (pareou com outro / foi reinstalado): para de insistir.
              const phone = this.phones.get(auth.deviceId)
              if (phone?.link) {
                delete phone.link
                this.save()
              }
            }
            return abort(
              reason === 'bad_code'
                ? 'Código incorreto. Confira o código que aparece no app do celular.'
                : reason === 'rate_limited'
                  ? 'Muitas tentativas erradas. Reinicie o compartilhamento no celular e tente de novo.'
                  : reason === 'bad_token'
                    ? 'O celular não reconhece mais este computador. Pareie de novo com o código.'
                    : `O celular recusou a conexão (${reason || 'erro'}).`
            )
          }
          if (msg.type !== 'link-ok') return abort('Resposta inesperada do celular.')
          if ('code' in auth) {
            if (typeof msg.linkToken !== 'string' || !/^[0-9a-f]{64}$/.test(msg.linkToken)) return abort('Resposta inválida do celular.')
            issuedSecret = msg.linkToken
          }
          stage = 'hello'
          return
        }
        if (stage === 'hello') {
          if (msg.type !== 'hello' || msg.role !== 'phone' || !validDeviceId(msg.deviceId)) {
            return abort('Resposta inválida do celular.', 'bad_request')
          }
          const id = msg.deviceId
          const name = deviceNameOf(msg)
          if ('code' in auth) {
            // O usuário digitou o endereço e o código que ESTE celular mostra: é ele. Emite (ou renova) o token.
            const token = this.issueToken(id, name, { host: target.host, port: target.port, secret: this.box.seal(issuedSecret!) })
            channel.send({ type: 'paired', token })
            this.emit({ type: 'paired', deviceId: id, name })
          } else {
            const phone = this.phones.get(id)
            const tokenOk = id === auth.deviceId && phone && typeof msg.token === 'string' && safeEqual(sha256(msg.token), phone.tokenHash)
            if (!tokenOk) return abort('O celular não apresentou um pareamento válido.', 'bad_token')
            // Atualiza o endereço se o usuário mudou a porta/IP manualmente em outra ocasião.
            phone.link = { ...phone.link!, host: target.host, port: target.port }
            channel.send({ type: 'ready' })
          }
          deviceId = id
          stage = 'linked'
          clearTimeout(handshakeTimer)
          socket.setTimeout(0)
          ping = setInterval(() => {
            if (!alive) return socket.destroy()
            alive = false
            channel.send({ type: 'ping' })
          }, PING_MS)
          this.attachPhone(channel, id)
          this.ensureLinkLoop()
          finish({ ok: true, deviceId: id, name })
          return
        }
        // Ligado: tudo que chega é sinalização do celular (ou pong).
        alive = true
        if (msg.type === 'pong' || msg.type === 'ping') return
        if (deviceId) this.relayFromPhone(deviceId, msg)
      }

      socket.on('data', (chunk: Buffer) => {
        if (ended) return
        alive = true
        buffer += chunk.toString('utf-8')
        if (buffer.length > MAX_MESSAGE_BYTES && !buffer.includes('\n')) return abort('Mensagem grande demais do celular.')
        let newline: number
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (!line) continue
          let msg: Json
          try {
            msg = JSON.parse(line) as Json
          } catch {
            continue
          }
          if (!msg || typeof msg.type !== 'string') continue
          try {
            onMessage(msg)
          } catch (error) {
            console.error('[deskbox] Falha ao tratar mensagem da conexão reversa:', error)
            socket.destroy()
            return
          }
          if (ended || socket.destroyed) return
        }
      })
    })
  }

  /** Para testes: um id novo e válido. */
  static newDeviceId(): string {
    return randomUUID()
  }
}
