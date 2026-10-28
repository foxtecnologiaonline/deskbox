// Teste ponta a ponta com o Electron de verdade (precisa de display: use `xvfb-run -a node scripts/e2e.mjs`
// ou `npm run e2e`, depois de `npm run build`). Controla o app via Chrome DevTools Protocol e verifica:
//   - CSS/JS personalizado por serviço (e que JS NÃO aprovado não executa);
//   - proxy por serviço (a requisição tem que passar pelo proxy configurado só naquele serviço);
//   - viewer do celular Android no BrowserView, com um "celular" simulado falando o protocolo
//     (sinalização + WebRTC real + DataChannel de controle).
import { spawn } from 'child_process'
import { createServer } from 'http'
import { createHash, randomBytes } from 'crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { createRequire } from 'module'
import WebSocket from 'ws'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = resolve(import.meta.dirname, '..')
const CDP_PORT = 9333
const sha256 = (s) => createHash('sha256').update(s, 'utf-8').digest('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  -> ${detail}` : ''}`)
}
async function waitFor(fn, desc, timeout = 20000, interval = 250) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) {
      last = e
    }
    await sleep(interval)
  }
  throw new Error(`timeout: ${desc}${last ? ` (${last.message})` : ''}`)
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((res, rej) => {
      this.ws.on('open', res)
      this.ws.on('error', rej)
    })
    this.listeners = new Map()
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString())
      if (m.method) this.listeners.get(m.method)?.forEach((fn) => fn(m.params))
      if (m.id && this.pending.has(m.id)) {
        const { resolve: ok, reject } = this.pending.get(m.id)
        this.pending.delete(m.id)
        m.error ? reject(new Error(m.error.message)) : ok(m.result)
      }
    })
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, [])
    this.listeners.get(method).push(fn)
  }
  async send(method, params = {}) {
    await this.ready
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error')
    return r.result.value
  }
  close() {
    this.ws.close()
  }
}
const listTargets = async () => (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
const findTarget = async (pred) => (await listTargets()).find((t) => t.type === 'page' && pred(t))

// ---------- servidores de apoio ----------
const proxyHits = []
const site = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end('<!doctype html><title>site</title><h1 id="h">hello</h1>')
})
const proxy = createServer((req, res) => {
  proxyHits.push({ url: req.url, host: req.headers.host })
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end('<!doctype html><title>via-proxy</title><h1 id="h">proxied</h1>')
})
await new Promise((r) => site.listen(0, '127.0.0.1', r))
await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
const sitePort = site.address().port
const proxyPort = proxy.address().port

// ---------- config do app ----------
const tmp = mkdtempSync(join(tmpdir(), 'deskbox-e2e-'))
const dataDir = join(tmp, 'DeskboxData')
mkdirSync(dataDir, { recursive: true })

const js1 = `document.title = 'js-ran'`
const DEVICE = 'e2e-device-0001'
const TOKEN = randomBytes(32).toString('hex')
const base = (id, name, url, extra = {}) => ({
  instanceId: id, catalogId: 'custom', name, url, domain: new URL(url.startsWith('http') ? url : 'http://127.0.0.1').hostname,
  partition: `persist:deskbox-${id}`, workspaceId: 'default', order: 0, muted: false, unreadCount: 0,
  hibernated: false, loading: false, pinned: false, iconUrl: null, proxy: null, customCss: '', customJs: '',
  approvedJsHash: null, jsPendingApproval: false, ...extra
})
const services = [
  base('s1', 'CSS+JS aprovado', `http://127.0.0.1:${sitePort}/`, { order: 0, customCss: 'h1#h{color:rgb(1,2,3)!important}', customJs: js1, approvedJsHash: sha256(js1) }),
  base('s2', 'JS pendente', `http://127.0.0.1:${sitePort}/`, { order: 1, customCss: 'h1#h{color:rgb(4,5,6)!important}', customJs: `document.title='SHOULD-NOT-RUN'` }),
  base('s3', 'Proxy por serviço', 'http://per-service-proxy.invalid/', { order: 2, proxy: { rules: `http=127.0.0.1:${proxyPort}` } }),
  base('s4', 'Pixel (sim)', `deskbox-phone://${DEVICE}`, { order: 3, catalogId: 'android-phone', domain: '127.0.0.1' })
]
writeFileSync(join(dataDir, 'deskbox-config.json'), JSON.stringify({ services, activeInstanceId: 's1', onboardingDismissed: true, hibernateAfterMinutes: null }, null, 2))
writeFileSync(join(dataDir, 'phones.json'), JSON.stringify([{ deviceId: DEVICE, name: 'Pixel (sim)', tokenHash: sha256(TOKEN), pairedAt: Date.now(), lastSeenAt: null }]))

// ---------- sobe o app ----------
const app = spawn(
  electronPath,
  [root, '--no-sandbox', `--remote-debugging-port=${CDP_PORT}`, '--disable-gpu', '--disable-features=WebRtcHideLocalIpsWithMdns', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  { env: { ...process.env, PORTABLE_EXECUTABLE_DIR: tmp, ELECTRON_ENABLE_LOGGING: '0' }, stdio: ['ignore', 'ignore', 'pipe'] }
)
let appErr = ''
app.stderr.on('data', (d) => (appErr += d))

let main
let simRef = null
let viewerRef = null
const viewerLog = []
async function diagnose() {
  console.log('--- diagnóstico ---')
  try { console.log('sim:', JSON.stringify(await simRef.eval('({ state: window.__sim && window.__sim.state, log: window.__sim && window.__sim.log, received: window.__sim && window.__sim.received })'))) } catch (e) { console.log('sim indisponível:', e.message) }
  try { console.log('viewer status:', JSON.stringify(await viewerRef.eval(`document.getElementById('status').textContent`))) } catch (e) { console.log('viewer indisponível:', e.message) }
  console.log('viewer console:', JSON.stringify(viewerLog.slice(-20)))
}
try {
  const mainTarget = await waitFor(() => findTarget((t) => t.url.includes('renderer/index.html')), 'janela principal', 30000)
  main = new Cdp(mainTarget.webSocketDebuggerUrl)
  const state = await waitFor(() => main.eval('window.deskbox.getState()'), 'estado do app')
  check('app sobe com os 4 serviços da config', state.services.length === 4)
  check('serviço de JS não aprovado é marcado como pendente', state.services.find((s) => s.instanceId === 's2').jsPendingApproval === true)
  check('serviço de JS aprovado não fica pendente', state.services.find((s) => s.instanceId === 's1').jsPendingApproval === false)

  // 1) s1: CSS + JS aprovado
  const t1 = await waitFor(() => findTarget((t) => t.url === `http://127.0.0.1:${sitePort}/` && t.title === 'js-ran'), 's1 com JS aprovado executado', 20000)
  const c1 = new Cdp(t1.webSocketDebuggerUrl)
  // O "celular" simulado roda nesta página (http comum, sem CSP) — a janela principal tem CSP `default-src 'self'`
  // e não pode abrir ws://; contornar isso com Page.setBypassCSP dependia de timing e falhava de forma intermitente no CI.
  simRef = c1
  check('JS aprovado executou (document.title)', t1.title === 'js-ran')
  check('CSS personalizado aplicado', (await c1.eval(`getComputedStyle(document.getElementById('h')).color`)) === 'rgb(1, 2, 3)')

  // 2) s2: CSS aplica, JS pendente NÃO executa
  await main.eval(`window.deskbox.selectService('s2')`)
  const t2 = await waitFor(async () => (await listTargets()).find((t) => t.type === 'page' && t.url === `http://127.0.0.1:${sitePort}/` && t.title !== 'js-ran'), 's2 carregado')
  const c2 = new Cdp(t2.webSocketDebuggerUrl)
  await sleep(500)
  check('JS pendente de aprovação NÃO executou', (await c2.eval('document.title')) === 'site')
  check('CSS do serviço pendente aplicado normalmente', (await c2.eval(`getComputedStyle(document.getElementById('h')).color`)) === 'rgb(4, 5, 6)')

  // 3) salvar as configurações aprova o JS, recarrega e executa; CSS troca sem recarregar a página
  await main.eval(`window.deskbox.setServiceSettings({ instanceId: 's2', proxy: null, customCss: 'h1#h{color:rgb(9,9,9)!important}', customJs: "document.title='approved-now'" })`)
  await waitFor(async () => (await findTarget((t) => t.title === 'approved-now')), 'JS executou após aprovar/salvar')
  const t2b = await findTarget((t) => t.title === 'approved-now')
  const c2b = new Cdp(t2b.webSocketDebuggerUrl)
  check('após salvar: CSS novo aplicado', (await c2b.eval(`getComputedStyle(document.getElementById('h')).color`)) === 'rgb(9, 9, 9)')
  const afterSave = await main.eval('window.deskbox.getState()')
  check('após salvar: serviço não está mais pendente', afterSave.services.find((s) => s.instanceId === 's2').jsPendingApproval === false)
  // só CSS muda → não recarrega (marca um estado na página e confere que sobrevive)
  await c2b.eval(`window.__marker = 42`)
  await main.eval(`window.deskbox.setServiceSettings({ instanceId: 's2', proxy: null, customCss: 'h1#h{color:rgb(7,7,7)!important}', customJs: "document.title='approved-now'" })`)
  await waitFor(async () => (await c2b.eval(`getComputedStyle(document.getElementById('h')).color`)) === 'rgb(7, 7, 7)', 'troca de CSS sem recarregar')
  check('troca só de CSS não recarrega a página', (await c2b.eval('window.__marker')) === 42)
  c2b.close(); c2.close()

  // 4) s3: proxy por serviço
  await main.eval(`window.deskbox.selectService('s3')`)
  await waitFor(() => findTarget((t) => t.title === 'via-proxy'), 'página servida via proxy do serviço')
  check('requisição do serviço passou pelo proxy configurado só nele', proxyHits.some((h) => h.host === 'per-service-proxy.invalid'))
  check('serviços sem proxy próprio NÃO usaram o proxy', !proxyHits.some((h) => (h.host || '').startsWith('127.0.0.1')))

  // 5) s4: viewer do celular
  await main.eval(`window.deskbox.selectService('s4')`)
  const viewerT = await waitFor(() => findTarget((t) => /^http:\/\/127\.0\.0\.1:\d+\/viewer\//.test(t.url)), 'viewer do celular no BrowserView')
  const viewerPort = new URL(viewerT.url).port
  const viewer = new Cdp(viewerT.webSocketDebuggerUrl)
  viewerRef = viewer
  await viewer.send('Runtime.enable')
  viewer.on('Runtime.consoleAPICalled', (p) => viewerLog.push(`${p.type}: ${(p.args || []).map((a) => a.value ?? a.description).join(' ')}`))
  viewer.on('Runtime.exceptionThrown', (p) => viewerLog.push(`EXC: ${p.exceptionDetails?.exception?.description || p.exceptionDetails?.text}`))
  check('viewer do celular carregou no BrowserView', true)
  check('viewer mostra "celular offline" antes de conectar', await waitFor(async () => /offline/i.test(await viewer.eval(`(document.getElementById('status') || document.body).textContent`)), 'status offline').then(() => true, async (e) => { console.log('viewer body:', await viewer.eval('document.body ? document.body.innerText : location.href')); throw e }))

  // O celular (modo direto) fala com o servidor LAN, que é outro servidor/porta — o do viewer é só loopback.
  const lanPort = await main.eval(`window.deskbox.startPhonePairing().then((i) => i.port)`)
  await main.eval(`window.deskbox.cancelPhonePairing()`)
  check('servidor LAN do celular separado do servidor do viewer', Number(lanPort) > 0 && String(lanPort) !== String(viewerPort), `lan=${lanPort} viewer=${viewerPort}`)

  const SIM = `(async () => {
    window.__sim = { received: [], state: 'init', log: [] };
    document.addEventListener('securitypolicyviolation', (e) => window.__sim.log.push('CSP violation: ' + e.violatedDirective + ' ' + e.blockedURI));
    window.addEventListener('unhandledrejection', (e) => window.__sim.log.push('unhandled: ' + (e.reason && e.reason.message || e.reason)));
    const ws = new WebSocket('ws://127.0.0.1:${lanPort}/signal');
    window.__sim.ws = ws;
    let pc = null;
    const canvas = document.createElement('canvas'); canvas.width = 360; canvas.height = 640;
    const ctx = canvas.getContext('2d'); let n = 0;
    setInterval(() => { ctx.fillStyle = 'hsl(' + ((n++ * 7) % 360) + ',70%,50%)'; ctx.fillRect(0, 0, 360, 640); }, 33);
    const send = (o) => ws.send(JSON.stringify(o));
    ws.onopen = () => send({ type: 'hello', role: 'phone', deviceId: '${DEVICE}', deviceName: 'Pixel (sim)', token: '${TOKEN}' });
    ws.onerror = () => window.__sim.log.push('ws error');
    ws.onclose = (e) => window.__sim.log.push('ws close ' + e.code);
    ws.onmessage = async (e) => {
      const m = JSON.parse(e.data);
      window.__sim.log.push('recv ' + m.type);
      try {
      if (m.type === 'ready') window.__sim.state = 'ready';
      else if (m.type === 'start') {
        if (pc) pc.close();
        pc = new RTCPeerConnection({ iceServers: [] });
        const stream = canvas.captureStream(30);
        stream.getTracks().forEach((t) => pc.addTrack(t, stream));
        const dc = pc.createDataChannel('control', { ordered: true });
        dc.onopen = () => { dc.send(JSON.stringify({ t: 'info', width: 1080, height: 1920, rotation: 0 })); dc.send(JSON.stringify({ t: 'a11y', enabled: true })); };
        dc.onmessage = (ev) => window.__sim.received.push(JSON.parse(ev.data));
        pc.onicecandidate = (ev) => { if (ev.candidate) send({ type: 'ice', candidate: { candidate: ev.candidate.candidate, sdpMid: ev.candidate.sdpMid, sdpMLineIndex: ev.candidate.sdpMLineIndex } }); };
        const offer = await pc.createOffer(); await pc.setLocalDescription(offer); send({ type: 'offer', sdp: offer.sdp });
        window.__sim.state = 'offered';
      }
      else if (m.type === 'answer') { await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }); window.__sim.state = 'answered'; }
      else if (m.type === 'ice' && pc) { try { await pc.addIceCandidate(m.candidate); } catch (e) {} }
      else if (m.type === 'stop') { if (pc) pc.close(); pc = null; window.__sim.state = 'stopped'; }
      } catch (err) { window.__sim.log.push('handler error on ' + m.type + ': ' + err.message); }
    };
    return 'started';
  })()`
  await simRef.eval(SIM)
  try {
    await waitFor(async () => (await simRef.eval('window.__sim.state')) === 'answered', 'celular simulado recebeu a resposta (answer) do viewer', 20000)
  } catch (e) {
    await diagnose()
    throw e
  }
  check('sinalização completa: viewer respondeu a oferta do celular', true)
  await waitFor(async () => (await viewer.eval(`document.getElementById('v').videoWidth`)) > 0, 'vídeo do celular chegando no viewer (WebRTC)', 25000)
  check('vídeo WebRTC do celular simulado renderizado no viewer', true)

  // 6) controle: tap, tecla, texto, swipe pelo mouse
  await viewer.eval(`document.getElementById('v').scrollIntoView()`)
  const rect = await viewer.eval(`(() => { const r = document.getElementById('v').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`)
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2
  const mouse = (type, x, y) => viewer.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse' })
  await mouse('mousePressed', cx, cy); await sleep(40); await mouse('mouseReleased', cx, cy)
  const tap = await waitFor(async () => (await simRef.eval('window.__sim.received')).find((m) => m.t === 'tap'), 'DataChannel recebeu "tap"')
  check('clique no vídeo vira "tap" normalizado no centro (±0.06)', Math.abs(tap.x - 0.5) < 0.06 && Math.abs(tap.y - 0.5) < 0.06, JSON.stringify(tap))

  await mouse('mousePressed', cx, cy + rect.h * 0.25); await sleep(60)
  await viewer.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, button: 'left', buttons: 1 }); await sleep(60)
  await mouse('mouseReleased', cx, cy - rect.h * 0.25)
  const swipe = await waitFor(async () => (await simRef.eval('window.__sim.received')).find((m) => m.t === 'swipe'), 'DataChannel recebeu "swipe"')
  check('arrastar vira "swipe" de baixo pra cima', swipe.y1 > swipe.y2 && swipe.ms >= 120, JSON.stringify(swipe))

  check('overlay de status some quando o vídeo conecta', (await viewer.eval(`document.getElementById('overlay').style.display`)) === 'none')

  // soltar FORA do quadro (acima da borda): o ponto final é preso à borda, não vira swipe de comprimento zero
  await simRef.eval('window.__sim.received.length = 0')
  await mouse('mousePressed', cx, cy); await sleep(60)
  await viewer.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: rect.y - 60, button: 'left', buttons: 1 }); await sleep(60)
  await mouse('mouseReleased', cx, rect.y - 60)
  const edgeSwipe = await waitFor(async () => (await simRef.eval('window.__sim.received')).find((m) => m.t === 'swipe'), 'swipe que termina fora do quadro')
  check('swipe que termina acima do quadro é preso à borda (y2≈0), não zerado', edgeSwipe.y2 <= 0.01 && edgeSwipe.y1 > 0.3, JSON.stringify(edgeSwipe))

  await viewer.eval(`document.querySelector('#bar button[data-key="home"]').click()`)
  const key = await waitFor(async () => (await simRef.eval('window.__sim.received')).find((m) => m.t === 'key' && m.key === 'home'), 'DataChannel recebeu "key:home"')
  check('botão Início envia key:home', Boolean(key))

  await viewer.eval(`(() => { const i = document.getElementById('text'); i.value = 'olá mundo'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })) })()`)
  const text = await waitFor(async () => (await simRef.eval('window.__sim.received')).find((m) => m.t === 'text'), 'DataChannel recebeu "text"')
  check('campo de texto envia "text"', text.text === 'olá mundo')

  // teclado direto: com o vídeo em foco, letras viram "text" (agrupadas) e Enter/Backspace viram teclas
  await simRef.eval('window.__sim.received.length = 0')
  await viewer.eval(`document.getElementById('v').focus()`)
  for (const ch of 'oi') await viewer.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch })
  await viewer.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  await viewer.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  const typedSeq = await waitFor(async () => {
    const r = await simRef.eval('window.__sim.received')
    return r.some((m) => m.t === 'key' && m.key === 'enter') ? r : null
  }, 'teclas digitadas com o vídeo em foco')
  const order = typedSeq.map((m) => (m.t === 'text' ? `text:${m.text}` : `${m.t}:${m.key}`)).join(' ')
  check('teclado direto: "oi" + Backspace + Enter chegam em ordem', order === 'text:oi key:backspace key:enter', order)
  await viewer.eval(`document.querySelector('#bar button[data-key="enter"]').click()`)
  check('botão ⏎ envia key:enter', Boolean(await waitFor(async () => (await simRef.eval('window.__sim.received')).filter((m) => m.key === 'enter').length >= 2 || null, 'botão enter')))

  // celular para de compartilhar (bye): o viewer limpa o quadro e avisa, em vez de congelar a última imagem
  await simRef.eval(`window.__sim.ws.send(JSON.stringify({ type: 'bye' }))`)
  await waitFor(async () => /parou de compartilhar/i.test(await viewer.eval(`document.getElementById('status').textContent`)), 'viewer reage ao bye')
  check('bye: viewer avisa que o celular parou e solta o vídeo', (await viewer.eval(`document.getElementById('v').srcObject === null`)) === true)

  // 7) updater em modo desenvolvimento: não pode quebrar nem tentar baixar nada
  const upd = await main.eval('window.deskbox.checkForUpdates()')
  check('updater responde "unsupported" fora do app instalado', upd.state === 'unsupported' && Boolean(upd.currentVersion), JSON.stringify(upd))

  // 8) hibernar o viewer manda "stop" ao celular
  await main.eval(`window.deskbox.selectService('s1')`)
  viewer.close()
  // nada a verificar no estado do viewer aqui; o "stop" já é coberto em tests/phone-server.test.ts
} catch (error) {
  check(`execução do e2e: ${error.message}`, false)
  console.error(appErr.split('\n').filter((l) => /deskbox|Error/i.test(l) && !/dbus|gpu/i.test(l)).slice(-15).join('\n'))
} finally {
  main?.close()
  simRef?.close()
  app.kill('SIGTERM')
  await sleep(500)
  site.close(); proxy.close()
  rmSync(tmp, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} verificações passaram`)
process.exit(failed ? 1 : 0)
