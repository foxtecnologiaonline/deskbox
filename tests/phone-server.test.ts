import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { request } from 'http'
import { connect } from 'net'
import WebSocket from 'ws'
import { PhoneServer } from '../src/main/phone/phone-server'
import { VIEWER_JS } from '../src/main/phone/viewer'
import type { PhoneEvent } from '../src/shared/types'

let dir: string
let server: PhoneServer
/** Porta do servidor LAN (celular no modo direto). */
let port: number
/** Porta do servidor do viewer (só loopback). */
let vport: number
const events: PhoneEvent[] = []
const DEVICE = 'device-12345678'

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deskbox-phone-'))
  server = new PhoneServer(join(dir, 'phones.json'), (e) => events.push(e))
  port = await server.ensureLanServer()
  vport = await server.ensureViewerServer()
})
after(() => {
  server.dispose()
  rmSync(dir, { recursive: true, force: true })
})

function open(
  headers: Record<string, string> = {},
  onPort: number = port
): Promise<{ ws: WebSocket; msgs: any[]; next: (type: string) => Promise<any> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${onPort}/signal`, { headers })
    const msgs: any[] = []
    const waiters: Array<{ type: string; resolve: (m: any) => void }> = []
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString())
      const i = waiters.findIndex((w) => w.type === m.type)
      if (i >= 0) waiters.splice(i, 1)[0].resolve(m)
      else msgs.push(m)
    })
    const next = (type: string): Promise<any> => {
      const i = msgs.findIndex((m) => m.type === type)
      if (i >= 0) return Promise.resolve(msgs.splice(i, 1)[0])
      return new Promise((res, rej) => {
        waiters.push({ type, resolve: res })
        setTimeout(() => rej(new Error(`timeout esperando "${type}"`)), 3000)
      })
    }
    ws.on('open', () => resolve({ ws, msgs, next }))
    ws.on('error', reject)
  })
}

function get(path: string, host?: string, onPort: number = vport): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: onPort, path, headers: host ? { Host: host } : {} }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
let token = ''

test('script do viewer é JavaScript válido (é um template string do TS: escapes errados quebram a página)', () => {
  assert.doesNotThrow(() => new Function(VIEWER_JS))
})

test('pareamento: código errado falha, certo devolve token e emite evento', async () => {
  const info = await server.startPairing()
  assert.match(info.code, /^\d{6}$/)
  assert.ok(info.uri.startsWith('deskbox://pair?'))

  const bad = await open()
  bad.ws.send(JSON.stringify({ type: 'hello', role: 'phone', deviceId: DEVICE, deviceName: 'Pixel', code: '000000' === info.code ? '111111' : '000000' }))
  assert.equal((await bad.next('error')).reason, 'bad_code')

  const phone = await open()
  phone.ws.send(JSON.stringify({ type: 'hello', role: 'phone', deviceId: DEVICE, deviceName: 'Pixel 7', code: info.code }))
  const paired = await phone.next('paired')
  assert.match(paired.token, /^[0-9a-f]{64}$/)
  token = paired.token
  assert.ok(events.some((e) => e.type === 'paired' && e.deviceId === DEVICE && e.name === 'Pixel 7'))
  assert.equal(server.isPaired(DEVICE), true)
  phone.ws.close()
})

test('código é de uso único', async () => {
  const info = await server.startPairing()
  const a = await open()
  a.ws.send(JSON.stringify({ type: 'hello', role: 'phone', deviceId: 'device-aaaaaaaa', deviceName: 'A', code: info.code }))
  await a.next('paired')
  const b = await open()
  b.ws.send(JSON.stringify({ type: 'hello', role: 'phone', deviceId: 'device-bbbbbbbb', deviceName: 'B', code: info.code }))
  assert.equal((await b.next('error')).reason, 'expired')
  a.ws.close()
  server.forget('device-aaaaaaaa')
})

test('reconexão com token ok; token errado recusado', async () => {
  const ok = await open()
  ok.ws.send(JSON.stringify({ type: 'hello', role: 'phone', deviceId: DEVICE, token }))
  await ok.next('ready')
  ok.ws.close()
  const bad = await open()
  bad.ws.send(JSON.stringify({ type: 'hello', role: 'phone', deviceId: DEVICE, token: 'f'.repeat(64) }))
  assert.equal((await bad.next('error')).reason, 'bad_token')
})

test('viewer HTTP: só loopback com Host correto, só celular pareado', async () => {
  const okRes = await get(`/viewer/${DEVICE}`)
  assert.equal(okRes.status, 200)
  assert.match(okRes.body, /id="cfg"/)
  assert.equal((await get(`/viewer/${DEVICE}`, 'evil.example.com')).status, 403) // anti DNS-rebinding
  assert.equal((await get('/viewer/device-desconhecido')).status, 404)
  assert.equal((await get('/viewer.js')).status, 200)
  assert.equal((await get('/outra-coisa')).status, 404)
})

function viewerKey(html: string): string {
  const m = /<script type="application\/json" id="cfg">(.*?)<\/script>/s.exec(html)!
  return JSON.parse(m[1]).key
}

test('viewer WS: exige Origin do viewer e a chave por execução', async () => {
  const key = viewerKey((await get(`/viewer/${DEVICE}`)).body)

  const noOrigin = await open({}, vport)
  noOrigin.ws.send(JSON.stringify({ type: 'hello', role: 'viewer', deviceId: DEVICE, key }))
  assert.equal((await noOrigin.next('error')).reason, 'bad_request')

  const evilOrigin = await open({ Origin: 'https://evil.example.com' }, vport)
  evilOrigin.ws.send(JSON.stringify({ type: 'hello', role: 'viewer', deviceId: DEVICE, key }))
  assert.equal((await evilOrigin.next('error')).reason, 'bad_request')

  const wrongKey = await open({ Origin: `http://127.0.0.1:${vport}` }, vport)
  wrongKey.ws.send(JSON.stringify({ type: 'hello', role: 'viewer', deviceId: DEVICE, key: 'x'.repeat(64) }))
  assert.equal((await wrongKey.next('error')).reason, 'bad_request')
})

test('relay de sinalização celular ⇄ viewer e stop ao fechar o viewer', async () => {
  const key = viewerKey((await get(`/viewer/${DEVICE}`)).body)
  const viewer = await open({ Origin: `http://127.0.0.1:${vport}` }, vport)
  viewer.ws.send(JSON.stringify({ type: 'hello', role: 'viewer', deviceId: DEVICE, key }))
  assert.equal((await viewer.next('phone-offline')).type, 'phone-offline')

  const phone = await open()
  phone.ws.send(JSON.stringify({ type: 'hello', role: 'phone', deviceId: DEVICE, token }))
  await phone.next('ready')
  await viewer.next('phone-online')

  viewer.ws.send(JSON.stringify({ type: 'start' }))
  await phone.next('start')
  phone.ws.send(JSON.stringify({ type: 'offer', sdp: 'v=0 fake' }))
  assert.equal((await viewer.next('offer')).sdp, 'v=0 fake')
  viewer.ws.send(JSON.stringify({ type: 'answer', sdp: 'v=0 answer' }))
  assert.equal((await phone.next('answer')).sdp, 'v=0 answer')
  phone.ws.send(JSON.stringify({ type: 'ice', candidate: { candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 } }))
  assert.equal((await viewer.next('ice')).candidate.candidate, 'c')

  viewer.ws.close()
  await phone.next('stop')
  phone.ws.close()
})

test('esquecer o celular derruba a conexão e invalida o token', async () => {
  const phone = await open()
  phone.ws.send(JSON.stringify({ type: 'hello', role: 'phone', deviceId: DEVICE, token }))
  await phone.next('ready')
  const closed = new Promise<number>((res) => phone.ws.on('close', (code) => res(code)))
  server.forget(DEVICE)
  assert.equal(await closed, 4000)
  assert.equal(server.isPaired(DEVICE), false)
  assert.equal((await get(`/viewer/${DEVICE}`)).status, 404)
})

test('rate limit: 5 códigos errados bloqueiam até o código certo', async () => {
  const info = await server.startPairing()
  const wrong = info.code === '123456' ? '654321' : '123456'
  for (let i = 0; i < 5; i++) {
    const c = await open()
    c.ws.send(JSON.stringify({ type: 'hello', role: 'phone', deviceId: 'device-cccccccc', code: wrong }))
    await c.next('error')
  }
  const blocked = await open()
  blocked.ws.send(JSON.stringify({ type: 'hello', role: 'phone', deviceId: 'device-cccccccc', code: info.code }))
  assert.equal((await blocked.next('error')).reason, 'rate_limited')
  assert.equal(server.isPaired('device-cccccccc'), false)
})

function rawRequest(raw: string, onPort: number = port): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(onPort, '127.0.0.1', () => socket.write(raw))
    let data = ''
    socket.on('data', (c) => (data += c))
    socket.on('close', () => resolve(data))
    socket.on('error', reject)
    setTimeout(() => {
      socket.destroy()
      resolve(data)
    }, 800)
  })
}

test('alvos malformados na rede não derrubam o processo (DoS) e o servidor segue respondendo', async () => {
  const uncaught: Error[] = []
  const onUncaught = (e: Error): void => void uncaught.push(e)
  process.on('uncaughtException', onUncaught)
  try {
    await rawRequest(`GET // HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`)
    await rawRequest(`GET //evil HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`)
    await rawRequest(`GET http:// HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`)
    await rawRequest(`GET // HTTP/1.1\r\nHost: 127.0.0.1:${vport}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`, vport)
    assert.equal((await get('/viewer/%E0')).status, 404)
    assert.equal((await get('/viewer/%ZZ%00')).status, 404)
    assert.equal((await get('/%')).status, 404)
    await sleep(100)
    assert.deepEqual(uncaught.map((e) => e.message), [], 'exceção não tratada no servidor')
    assert.equal((await get('/viewer.js')).status, 200, 'servidor deixou de responder')
  } finally {
    process.off('uncaughtException', onUncaught)
  }
})

test('JSON malformado / mensagens estranhas do cliente não derrubam o servidor', async () => {
  const c = await open()
  c.ws.send('isso não é json')
  c.ws.send('{"type":123}')
  c.ws.send(JSON.stringify({ type: 'hello', role: 'phone', deviceId: { x: 1 } }))
  c.ws.send(JSON.stringify({ type: 'hello', role: 'phone', deviceId: 'device-zzzzzzzz', code: { a: 1 } }))
  await sleep(150)
  assert.equal((await get('/viewer.js')).status, 200)
})

// 127.0.0.N só existe como loopback no Linux/Windows; no macOS o bind em 127.0.0.2 falha — nesse caso o teste se ignora.
async function canBindLoopbackAlias(): Promise<boolean> {
  const { createServer } = await import('net')
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(0, '127.0.0.2', () => probe.close(() => resolve(true)))
  })
}

test('teto global por código: tentativas erradas de IPs diferentes invalidam o pareamento', async (t) => {
  if (!(await canBindLoopbackAlias())) return t.skip('sem alias de loopback 127.0.0.N neste sistema')
  const info = await server.startPairing()
  const wrong = info.code === '111111' ? '222222' : '111111'
  for (let i = 2; i < 12; i++) {
    // 127.0.0.N são todos loopback no Linux: serve pra simular origens diferentes (cada uma com 1 erro só).
    const ws = new WebSocket(`ws://127.0.0.1:${port}/signal`, { localAddress: `127.0.0.${i}` })
    await new Promise<void>((res, rej) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'hello', role: 'phone', deviceId: 'device-dddddddd', code: wrong }))
      })
      ws.on('message', () => res())
      ws.on('error', rej)
    })
  }
  // IP "limpo": 127.0.0.1 já acumulou erros nos testes anteriores e cairia em rate_limited antes de checar o código.
  const late = await new Promise<Awaited<ReturnType<typeof open>>>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/signal`, { localAddress: '127.0.0.99' })
    const msgs: any[] = []
    const waiters: Array<{ type: string; resolve: (m: any) => void }> = []
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString())
      const i = waiters.findIndex((w) => w.type === m.type)
      if (i >= 0) waiters.splice(i, 1)[0].resolve(m)
      else msgs.push(m)
    })
    const next = (type: string): Promise<any> => {
      const i = msgs.findIndex((m) => m.type === type)
      if (i >= 0) return Promise.resolve(msgs.splice(i, 1)[0])
      return new Promise((res, rej) => {
        waiters.push({ type, resolve: res })
        setTimeout(() => rej(new Error(`timeout esperando "${type}"`)), 3000)
      })
    }
    ws.on('open', () => resolve({ ws, msgs, next }))
    ws.on('error', reject)
  })
  late.ws.send(JSON.stringify({ type: 'hello', role: 'phone', deviceId: 'device-dddddddd', code: info.code }))
  assert.equal((await late.next('error')).reason, 'expired', 'o código certo ainda funcionou depois de 10 chutes errados')
  assert.equal(server.isPaired('device-dddddddd'), false)
})

test('servidores separados: viewer só no loopback, celular só no LAN', async () => {
  // A página do viewer não existe no servidor exposto à rede.
  assert.equal((await get(`/viewer/${DEVICE}`, `127.0.0.1:${port}`, port)).status, 404)
  // Viewer no servidor LAN: recusado (nem chega a conferir a chave).
  const viewerOnLan = await open({ Origin: `http://127.0.0.1:${vport}` }, port)
  viewerOnLan.ws.send(JSON.stringify({ type: 'hello', role: 'viewer', deviceId: DEVICE, key: 'x'.repeat(64) }))
  assert.equal((await viewerOnLan.next('error')).reason, 'bad_request')
  // Celular no servidor do viewer: recusado.
  const info = await server.startPairing()
  const phoneOnViewer = await open({}, vport)
  phoneOnViewer.ws.send(JSON.stringify({ type: 'hello', role: 'phone', deviceId: 'device-eeeeeeee', code: info.code }))
  assert.equal((await phoneOnViewer.next('error')).reason, 'bad_request')
  server.cancelPairing()
})

test('QR leva endereços alternativos além do principal', async () => {
  const info = await server.startPairing()
  const uri = new URL(info.uri.replace('deskbox://', 'http://'))
  assert.equal(uri.searchParams.get('host'), info.hosts[0] ?? '127.0.0.1')
  if (info.hosts.length > 1) assert.equal(uri.searchParams.get('alt'), info.hosts.slice(1, 4).join(','))
  server.cancelPairing()
})

// ---------- conexão reversa (Deskbox → celular) ----------

interface FakePhone {
  port: number
  deviceId: string
  /** Token que o Deskbox emitiu para o celular (como o app guarda em Prefs.token). */
  deskboxToken: string | null
  linkTokens: Set<string>
  next: (type: string) => Promise<any>
  send: (msg: object) => void
  dropConnection: () => void
  connections: number
  close: () => void
}

/** Celular simulado do lado do app: escuta TCP e fala JSON por linha (docs/phone-protocol.md § conexão reversa). */
async function fakePhone(code: string, deviceId: string): Promise<FakePhone> {
  const { createServer: createNetServer } = await import('net')
  const { randomBytes } = await import('crypto')
  const msgs: any[] = []
  const waiters: Array<{ type: string; resolve: (m: any) => void }> = []
  let current: import('net').Socket | null = null
  const phone: FakePhone = {
    port: 0,
    deviceId,
    deskboxToken: null,
    linkTokens: new Set(),
    connections: 0,
    next: (type) => {
      const i = msgs.findIndex((m) => m.type === type)
      if (i >= 0) return Promise.resolve(msgs.splice(i, 1)[0])
      return new Promise((res, rej) => {
        waiters.push({ type, resolve: res })
        setTimeout(() => rej(new Error(`celular simulado: timeout esperando "${type}"`)), 8000)
      })
    },
    send: (msg) => current?.write(`${JSON.stringify(msg)}\n`),
    dropConnection: () => current?.destroy(),
    close: () => {
      current?.destroy()
      netServer.close()
    }
  }
  const netServer = createNetServer((sock) => {
    let buf = ''
    let authed = false
    const send = (m: object): void => void sock.write(`${JSON.stringify(m)}\n`)
    sock.on('error', () => undefined)
    sock.on('data', (d) => {
      buf += d.toString()
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i))
        buf = buf.slice(i + 1)
        if (!authed) {
          if (m.type !== 'link-hello') return void sock.destroy()
          if (typeof m.code === 'string' && m.code === code) {
            const lt = randomBytes(32).toString('hex')
            phone.linkTokens.add(lt)
            send({ type: 'link-ok', linkToken: lt })
          } else if (typeof m.linkToken === 'string' && phone.linkTokens.has(m.linkToken)) {
            send({ type: 'link-ok' })
          } else {
            send({ type: 'error', reason: m.code ? 'bad_code' : 'bad_token' })
            return void sock.end()
          }
          authed = true
          current = sock
          phone.connections++
          send({ type: 'hello', role: 'phone', deviceId, deviceName: 'Fake Phone', ...(phone.deskboxToken ? { token: phone.deskboxToken } : {}) })
          continue
        }
        if (m.type === 'paired') phone.deskboxToken = m.token
        if (m.type === 'ping') send({ type: 'pong' })
        const w = waiters.findIndex((x) => x.type === m.type)
        if (w >= 0) waiters.splice(w, 1)[0].resolve(m)
        else msgs.push(m)
      }
    })
  })
  await new Promise<void>((res) => netServer.listen(0, '127.0.0.1', () => res()))
  phone.port = (netServer.address() as import('net').AddressInfo).port
  return phone
}

test('conexão reversa: recusa endereço fora da LAN, código mal formado e código errado', async () => {
  assert.equal((await server.linkPhone('8.8.8.8:47891', '123456')).ok, false)
  assert.equal((await server.linkPhone('exemplo.com', '123456')).ok, false)
  assert.equal((await server.linkPhone('192.168.0.10:99999', '123456')).ok, false)
  assert.equal((await server.linkPhone('192.168.0.10', '12ab')).ok, false)
  const phone = await fakePhone('424242', 'device-link-wrong01')
  try {
    const wrong = await server.linkPhone(`127.0.0.1:${phone.port}`, '000000')
    assert.equal(wrong.ok, false)
    assert.match(wrong.ok ? '' : wrong.error, /Código incorreto/)
    assert.equal(server.isPaired('device-link-wrong01'), false)
  } finally {
    phone.close()
  }
})

test('conexão reversa: pareia pelo código do celular, repassa a sinalização e religa sozinha', async () => {
  const id = 'device-link-0001'
  const phone = await fakePhone('135790', id)
  try {
    const result = await server.linkPhone(`127.0.0.1:${phone.port}`, '135790')
    assert.deepEqual(result, { ok: true, deviceId: id, name: 'Fake Phone' })
    const paired = await phone.next('paired')
    assert.match(paired.token, /^[0-9a-f]{64}$/)
    assert.ok(events.some((e) => e.type === 'paired' && e.deviceId === id))
    assert.equal(server.isPaired(id), true)
    assert.equal(server.hasDirectPhones(), false, 'celular da conexão reversa não exige o servidor LAN')

    // Viewer abre: o celular (conectado por TCP) recebe o start e a oferta volta pro viewer.
    const key = viewerKey((await get(`/viewer/${id}`)).body)
    const viewer = await open({ Origin: `http://127.0.0.1:${vport}` }, vport)
    viewer.ws.send(JSON.stringify({ type: 'hello', role: 'viewer', deviceId: id, key }))
    await viewer.next('phone-online')
    viewer.ws.send(JSON.stringify({ type: 'start' }))
    await phone.next('start')
    phone.send({ type: 'offer', sdp: 'v=0 reverse' })
    assert.equal((await viewer.next('offer')).sdp, 'v=0 reverse')
    viewer.ws.send(JSON.stringify({ type: 'answer', sdp: 'v=0 answer' }))
    assert.equal((await phone.next('answer')).sdp, 'v=0 answer')

    // A conexão cai (Wi-Fi oscilou): o viewer vê offline e o Deskbox religa sozinho com o segredo do celular.
    phone.dropConnection()
    await viewer.next('phone-offline')
    await viewer.next('phone-online')
    assert.equal(phone.connections, 2)
    await phone.next('ready')

    // O segredo da conexão reversa não fica em texto puro no disco quando há cofre (aqui: SecretBox de teste).
    const saved = JSON.parse(readFileSync(join(dir, 'phones.json'), 'utf-8')).find((p: any) => p.deviceId === id)
    assert.equal(saved.link.port, phone.port)
    assert.ok(!JSON.stringify(saved).includes(paired.token), 'o token do Deskbox nunca vai para o disco')

    viewer.ws.close()
    await phone.next('stop')
  } finally {
    phone.close()
    server.forget(id)
  }
})

test('conexão reversa: celular que não reconhece mais o computador para de ser procurado', async () => {
  const id = 'device-link-0002'
  const phone = await fakePhone('246802', id)
  try {
    assert.equal((await server.linkPhone(`127.0.0.1:${phone.port}`, '246802')).ok, true)
    await phone.next('paired')
    phone.linkTokens.clear() // o celular "esqueceu" este computador (pareou com outro)
    phone.dropConnection()
    const key = viewerKey((await get(`/viewer/${id}`)).body)
    const viewer = await open({ Origin: `http://127.0.0.1:${vport}` }, vport)
    viewer.ws.send(JSON.stringify({ type: 'hello', role: 'viewer', deviceId: id, key }))
    await viewer.next('phone-offline')
    await sleep(400)
    const saved = JSON.parse(readFileSync(join(dir, 'phones.json'), 'utf-8')).find((p: any) => p.deviceId === id)
    assert.equal(saved.link, undefined, 'o vínculo recusado deveria ter sido descartado')
    viewer.ws.close()
  } finally {
    phone.close()
    server.forget(id)
  }
})
