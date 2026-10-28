/**
 * Página do viewer (carregada num BrowserView do Deskbox) e seu script. Servidas pelo PhoneServer
 * apenas em loopback. Implementam o lado "viewer" de docs/phone-protocol.md.
 */

export function viewerHtml(deviceId: string, key: string, port: number): string {
  const config = JSON.stringify({ deviceId, key, port }).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Celular Android</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src ws://127.0.0.1:${port}; media-src blob: mediastream:; img-src data:">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #0f1115; color: #e7e9ee; font: 14px system-ui, sans-serif; overflow: hidden; }
  #app { display: flex; flex-direction: column; height: 100%; }
  #stage { flex: 1; min-height: 0; position: relative; display: flex; align-items: center; justify-content: center; }
  video { max-width: 100%; max-height: 100%; background: #000; border-radius: 10px; cursor: pointer; touch-action: none; outline: none; }
  #overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 24px; pointer-events: none; }
  #overlay span { background: rgba(0,0,0,.65); padding: 10px 16px; border-radius: 10px; max-width: 420px; line-height: 1.5; }
  #bar { display: flex; gap: 6px; padding: 8px; background: #171a21; align-items: center; }
  #bar button { background: #262b36; color: inherit; border: 0; padding: 8px 12px; border-radius: 8px; cursor: pointer; font-size: 13px; }
  #bar button:hover { background: #313847; }
  #bar button:disabled { opacity: .4; cursor: default; }
  #text { flex: 1; min-width: 0; background: #0f1115; color: inherit; border: 1px solid #2b3140; border-radius: 8px; padding: 8px 10px; font-size: 13px; }
  #viewonly { display: none; background: #5a3b00; color: #ffd48a; padding: 6px 12px; font-size: 12px; text-align: center; }
</style>
</head>
<body>
<div id="app">
  <div id="viewonly">Somente visualização: ative o serviço de acessibilidade do Deskbox no celular para controlar o aparelho.</div>
  <div id="stage">
    <video id="v" autoplay playsinline muted tabindex="0"></video>
    <div id="overlay"><span id="status">Conectando…</span></div>
  </div>
  <div id="bar">
    <button data-key="back" title="Voltar">◀ Voltar</button>
    <button data-key="home" title="Início">● Início</button>
    <button data-key="recents" title="Apps recentes">▣ Recentes</button>
    <button data-key="notifications" title="Notificações">🔔</button>
    <input id="text" placeholder="Digitar no celular (Enter envia)" autocomplete="off">
  </div>
</div>
<script type="application/json" id="cfg">${config}</script>
<script src="/viewer.js"></script>
</body>
</html>`
}

export const VIEWER_JS = `(() => {
  const cfg = JSON.parse(document.getElementById('cfg').textContent);
  const video = document.getElementById('v');
  const statusEl = document.getElementById('status');
  const overlay = document.getElementById('overlay');
  const viewOnly = document.getElementById('viewonly');
  const textInput = document.getElementById('text');
  let ws = null, pc = null, channel = null, phoneOnline = false, pendingIce = [], remoteSet = false;
  let reconnectDelay = 500, retryTimer = null;
  let screenInfo = null, a11y = true;

  function setStatus(msg) {
    statusEl.textContent = msg || '';
    overlay.style.display = msg ? 'flex' : 'none';
  }
  function sendWs(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  function sendControl(obj) { if (channel && channel.readyState === 'open') channel.send(JSON.stringify(obj)); }

  function closePeer() {
    if (channel) { try { channel.close(); } catch {} }
    if (pc) { try { pc.close(); } catch {} }
    pc = null; channel = null; remoteSet = false; pendingIce = [];
    video.srcObject = null;
  }

  function startSession() {
    closePeer();
    pc = new RTCPeerConnection({ iceServers: [] });
    pc.ontrack = (e) => { video.srcObject = e.streams[0] || new MediaStream([e.track]); setStatus(''); video.focus(); };
    pc.onicecandidate = (e) => { if (e.candidate) sendWs({ type: 'ice', candidate: { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex } }); };
    pc.ondatachannel = (e) => {
      channel = e.channel;
      channel.onmessage = (m) => {
        try {
          const msg = JSON.parse(m.data);
          if (msg.t === 'info') screenInfo = msg;
          if (msg.t === 'a11y') { a11y = !!msg.enabled; viewOnly.style.display = a11y ? 'none' : 'block'; }
        } catch {}
      };
    };
    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') scheduleRestart();
      if (pc.connectionState === 'disconnected') setStatus('Conexão com o celular instável…');
      if (pc.connectionState === 'connected') setStatus('');
    };
    setStatus('Aguardando o celular iniciar o compartilhamento de tela…');
    sendWs({ type: 'start' });
  }

  function scheduleRestart() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; if (phoneOnline) startSession(); }, 2000);
  }

  async function handleOffer(sdp) {
    if (!pc) return;
    await pc.setRemoteDescription({ type: 'offer', sdp });
    remoteSet = true;
    for (const c of pendingIce) { try { await pc.addIceCandidate(c); } catch {} }
    pendingIce = [];
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendWs({ type: 'answer', sdp: answer.sdp });
  }

  function connect() {
    ws = new WebSocket('ws://127.0.0.1:' + cfg.port + '/signal');
    ws.onopen = () => { reconnectDelay = 500; sendWs({ type: 'hello', role: 'viewer', deviceId: cfg.deviceId, key: cfg.key }); };
    ws.onmessage = async (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'phone-online') { phoneOnline = true; startSession(); }
      else if (msg.type === 'phone-offline') { phoneOnline = false; closePeer(); setStatus('Celular offline. Abra o app Deskbox no celular (mesma rede Wi-Fi) e toque em iniciar.'); }
      else if (msg.type === 'bye') { closePeer(); setStatus('O celular parou de compartilhar a tela.'); }
      else if (msg.type === 'offer') { try { await handleOffer(msg.sdp); } catch (err) { console.error(err); } }
      else if (msg.type === 'ice' && msg.candidate) {
        if (pc && remoteSet) { try { await pc.addIceCandidate(msg.candidate); } catch {} } else pendingIce.push(msg.candidate);
      }
      else if (msg.type === 'error') setStatus('Erro: ' + (msg.reason || 'desconhecido'));
    };
    ws.onclose = () => {
      phoneOnline = false; closePeer();
      setStatus('Reconectando ao Deskbox…');
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 5000);
    };
  }

  // Coordenadas normalizadas (0..1) relativas à tela do celular, descontando as faixas pretas do object-fit.
  // clampToEdge: ao soltar fora do quadro (ex.: arrastar até passar da borda de cima) usa a borda mais próxima
  // em vez de descartar o ponto — senão um gesto que termina fora virava um swipe de comprimento zero.
  function normalize(ev, clampToEdge) {
    const r = video.getBoundingClientRect();
    const vw = video.videoWidth || r.width, vh = video.videoHeight || r.height;
    const scale = Math.min(r.width / vw, r.height / vh);
    const w = vw * scale, h = vh * scale;
    const left = r.left + (r.width - w) / 2, top = r.top + (r.height - h) / 2;
    const x = (ev.clientX - left) / w, y = (ev.clientY - top) / h;
    if (clampToEdge) return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
    return (x < 0 || x > 1 || y < 0 || y > 1) ? null : { x, y };
  }

  let down = null;
  video.addEventListener('pointerdown', (ev) => {
    video.setPointerCapture(ev.pointerId);
    const p = normalize(ev);
    if (p) down = { ...p, t: performance.now(), cx: ev.clientX, cy: ev.clientY };
  });
  video.addEventListener('pointerup', (ev) => {
    if (!down) return;
    const start = down; down = null;
    const p = normalize(ev, true);
    const ms = Math.round(performance.now() - start.t);
    const moved = Math.hypot(ev.clientX - start.cx, ev.clientY - start.cy);
    if (moved < 8) {
      if (ms >= 500) sendControl({ t: 'longpress', x: start.x, y: start.y, ms });
      else sendControl({ t: 'tap', x: start.x, y: start.y });
    } else {
      sendControl({ t: 'swipe', x1: start.x, y1: start.y, x2: p.x, y2: p.y, ms: Math.min(1500, Math.max(120, ms)) });
    }
  });
  video.addEventListener('pointercancel', () => { down = null; });
  video.addEventListener('contextmenu', (e) => { e.preventDefault(); sendControl({ t: 'key', key: 'back' }); });

  let wheelLock = 0;
  video.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const now = performance.now();
    if (now - wheelLock < 220) return;
    wheelLock = now;
    const p = normalize(ev) || { x: 0.5, y: 0.5 };
    const dy = Math.max(-0.4, Math.min(0.4, -ev.deltaY / 600));
    const dx = Math.max(-0.4, Math.min(0.4, -ev.deltaX / 600));
    sendControl({ t: 'swipe', x1: p.x, y1: p.y, x2: Math.min(1, Math.max(0, p.x + dx)), y2: Math.min(1, Math.max(0, p.y + dy)), ms: 200 });
  }, { passive: false });

  document.querySelectorAll('#bar button[data-key]').forEach((b) => b.addEventListener('click', () => sendControl({ t: 'key', key: b.dataset.key })));
  textInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && textInput.value) { sendControl({ t: 'text', text: textInput.value }); textInput.value = ''; }
  });

  connect();
})();
`
