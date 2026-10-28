import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { request } from 'http'
import { connect } from 'net'
import WebSocket from 'ws'
import { PhoneServer } from '../src/main/phone/phone-server'
import type { PhoneEvent } from '../src/shared/types'

let dir: string
let server: PhoneServer
let port: number
const events: PhoneEvent[] = []
const DEVICE = 'device-12345678'

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deskbox-phone-'))
  server = new PhoneServer(join(dir, 'phones.json'), (e) => events.push(e))
  port = await server.ensureStarted()
})
after(() => {
  server.dispose()
  rmSync(dir, { recursive: true, force: true })
})

function open(headers: Record<string, string> = {}): Promise<{ ws: WebSocket; msgs: any[]; next: (type: string) => Promise<any> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/signal`, { headers })
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

function get(path: string, host?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: host ? { Host: host } : {} }, (res) => {
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

  const noOrigin = await open()
  noOrigin.ws.send(JSON.stringify({ type: 'hello', role: 'viewer', deviceId: DEVICE, key }))
  assert.equal((await noOrigin.next('error')).reason, 'bad_request')

  const evilOrigin = await open({ Origin: 'https://evil.example.com' })
  evilOrigin.ws.send(JSON.stringify({ type: 'hello', role: 'viewer', deviceId: DEVICE, key }))
  assert.equal((await evilOrigin.next('error')).reason, 'bad_request')

  const wrongKey = await open({ Origin: `http://127.0.0.1:${port}` })
  wrongKey.ws.send(JSON.stringify({ type: 'hello', role: 'viewer', deviceId: DEVICE, key: 'x'.repeat(64) }))
  assert.equal((await wrongKey.next('error')).reason, 'bad_request')
})

test('relay de sinalização celular ⇄ viewer e stop ao fechar o viewer', async () => {
  const key = viewerKey((await get(`/viewer/${DEVICE}`)).body)
  const viewer = await open({ Origin: `http://127.0.0.1:${port}` })
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

function rawRequest(raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(raw))
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
