# Protocolo Deskbox ⇄ app Android (controle de celular)

Contrato entre o servidor embutido no Deskbox (`src/main/phone/`) e o app companion (`android/`). Decisão de v1: **somente rede local (LAN)** — sem relay/STUN/TURN. Celular e computador precisam estar na mesma rede Wi-Fi. Acesso remoto (fora da LAN) fica como evolução: exige um servidor de sinalização público + TURN e é uma decisão de infraestrutura separada.

## Visão geral

```
 Celular Android                         Deskbox (Electron)
 ┌────────────────────┐   WebSocket     ┌─────────────────────────────┐
 │ MediaProjection    │  /signal (LAN)  │ main: PhoneServer (http+ws) │
 │ + WebRTC (offer)   │◄───────────────►│  - pareamento (código 6 díg)│
 │ + AccessibilityS.  │                 │  - relay de sinalização     │
 └─────────┬──────────┘                 └──────────┬──────────────────┘
           │   WebRTC (mídia + DataChannel)        │ ws (loopback)
           └───────────────────────────────────────┼────────┐
                                                   ▼        │
                                      BrowserView "viewer"  │
                                      <video> + eventos ────┘
```

O viewer é uma página HTML servida pelo próprio `PhoneServer` em `http://127.0.0.1:<porta>/viewer/<deviceId>` e carregada num `BrowserView` como qualquer outro serviço do Deskbox.

## Servidor

- Porta padrão **47890** (se ocupada, tenta as próximas 20). Escuta em `0.0.0.0`.
- `GET /viewer/<deviceId>` e `GET /viewer.js` → **somente loopback** (`127.0.0.1`/`::1`), 403 caso contrário.
- `WS /signal` → aceita celular (qualquer IP da LAN, autenticado) e viewer (somente loopback).

## Pareamento

1. Usuário abre "Adicionar celular Android" no Deskbox → o servidor gera um **código de 6 dígitos**, válido por **5 min**, **uso único**.
2. A tela mostra IP(s) da LAN, porta, código e um QR com a URI:
   `deskbox://pair?host=<ip>&port=<porta>&code=<código>`
3. No app: escanear o QR **ou** digitar host/porta/código manualmente.
4. App abre `ws://<host>:<porta>/signal` e envia `hello` com `code`. Em sucesso o servidor responde `paired` com um `token` (32 bytes hex) que o app **persiste** e usa nas reconexões (sem código).
5. Limite de tentativas: 5 códigos errados por IP em 10 min → `rate_limited`.

## Mensagens de sinalização (JSON, texto, em `/signal`)

Todas têm `type`. Campos ausentes/extra são ignorados.

### Celular → servidor
| type | campos | quando |
|---|---|---|
| `hello` | `role:"phone"`, `deviceId` (UUID persistido no app), `deviceName`, e **`code`** (1º pareamento) **ou** `token` (reconexão) | 1ª mensagem após abrir o WS |
| `offer` | `sdp` | em resposta a `start` |
| `ice` | `candidate:{candidate,sdpMid,sdpMLineIndex}` | candidatos locais |
| `bye` | — | usuário parou o compartilhamento |

### Servidor → celular
| type | campos |
|---|---|
| `paired` | `token` |
| `ready` | — (token válido, aguardando viewer) |
| `start` | — (um viewer quer assistir: o celular cria PeerConnection e envia `offer`) |
| `answer` | `sdp` |
| `ice` | `candidate` |
| `stop` | — (viewer fechou: encerrar PeerConnection, manter WS) |
| `error` | `reason`: `bad_code` \| `expired` \| `bad_token` \| `rate_limited` \| `bad_request` |

Após `error` o servidor fecha o WS. Ping/pong WS a cada 15 s; o app reconecta com backoff (1 s → 30 s) usando `token`.

### Viewer (loopback) ⇄ servidor
| direção | type | campos |
|---|---|---|
| V→S | `hello` | `role:"viewer"`, `deviceId` |
| S→V | `phone-online` / `phone-offline` | — (estado do celular desse `deviceId`) |
| V→S | `start` | — (encaminhado ao celular) |
| V→S / S→V | `answer`, `ice`, `offer`, `stop` | relay para/do celular do mesmo `deviceId` |

O servidor apenas **repassa** `offer/answer/ice/start/stop/bye` entre o celular e o viewer com o mesmo `deviceId`.

Detalhes de comportamento (testados em `tests/phone-server.test.ts`):
- **Quem inicia a oferta:** o servidor não guarda estado de "viewer esperando". Quando o celular conecta, o servidor manda `phone-online` aos viewers e **o viewer responde com `start`**, que é repassado ao celular. Portanto o celular só precisa aguardar `start` depois de `ready`/`paired` — não deve ofertar por conta própria.
- Quando o último viewer fecha, o servidor manda `stop` ao celular (parar a transmissão sem derrubar o WS).
- `error` é terminal: o servidor fecha o WS logo depois. O app **não** deve reconectar em loop após `bad_code`/`expired`/`rate_limited`/`bad_token` (precisa de novo pareamento); só reconecta com backoff em falhas de rede/fechamento sem `error`.
- **Defesas do viewer** (não afetam o app Android): o `hello` do viewer exige também `key` (segredo por execução embutido na página servida em loopback), `Origin` igual a `http://127.0.0.1:<porta>` e `Host` de loopback — impede que sites abertos no navegador do usuário falem com o servidor local.

## WebRTC

- **Quem oferta:** o celular (dono da faixa de vídeo), ao receber `start`.
- `iceServers: []` (apenas candidatos host/LAN).
- Vídeo: captura de tela via `MediaProjection`, **máx. 1280 px no maior lado** (preservando proporção), **30 fps**, bitrate alvo ~2,5 Mbps. Sem áudio na v1.
- **DataChannel** `"control"` criado pelo celular (`ordered:true`, confiável).

### DataChannel `control` (JSON texto)

Viewer → celular (coordenadas **normalizadas 0..1** relativas ao **quadro de vídeo transmitido**, origem no canto superior esquerdo; o viewer já desconta as faixas pretas do `object-fit`). Se o quadro transmitido tiver outra proporção que a tela atual (ex.: celular girou e a captura não foi recriada), é o **celular** que compensa o letterbox ao converter para pixels reais:

| `t` | campos | ação no celular |
|---|---|---|
| `tap` | `x,y` | toque de ~50 ms |
| `longpress` | `x,y`, `ms` (opcional, padrão 600) | toque longo |
| `swipe` | `x1,y1,x2,y2`, `ms` (padrão 300) | gesto de arrasto |
| `key` | `key`: `back` \| `home` \| `recents` \| `notifications` | `performGlobalAction` |
| `text` | `text` | `ACTION_SET_TEXT` no campo com foco de entrada (append ao texto atual) |

Celular → viewer:

| `t` | campos | quando |
|---|---|---|
| `info` | `width`, `height` (px reais da tela), `rotation` (0/90/180/270) | ao abrir o canal e a cada rotação |
| `a11y` | `enabled: boolean` | ao abrir o canal e quando o serviço de acessibilidade liga/desliga. Se `false`, o viewer funciona só como espelho (somente visualização) e mostra aviso |

## Requisitos do app Android

- `minSdk 26`, `targetSdk 34`, Kotlin.
- Permissões: `INTERNET`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PROJECTION`, `POST_NOTIFICATIONS`, `CAMERA` (só para escanear QR); tráfego cleartext permitido (ws:// na LAN) via `networkSecurityConfig`.
- Serviço em primeiro plano (`foregroundServiceType="mediaProjection"`) com notificação persistente e botão "Parar".
- `AccessibilityService` próprio (`canPerformGestures="true"`, `canRetrieveWindowContent="true"` para o `text`).
- Dependências sugeridas: `io.github.webrtc-sdk:android`, `com.squareup.okhttp3:okhttp`, `com.journeyapps:zxing-android-embedded`.
- Sempre mostrar ao usuário que a tela está sendo compartilhada e permitir parar a qualquer momento.

## Limitações conhecidas (v1)

- **Sinalização sem TLS**: o WebSocket `ws://` na LAN carrega o código (uso único) e o token de pareamento em texto claro. Quem estiver capturando tráfego na mesma Wi-Fi durante um pareamento/reconexão pode obter o token e se passar pelo celular (e então receber os toques/textos que o usuário digitar no viewer). **Use apenas em redes confiáveis.** Mitigação planejada para v2: `wss://` com certificado autoassinado gerado no Deskbox e **fingerprint SHA-256 incluído no QR** (o app Android confere o fingerprint em vez de confiar em CAs), mais nonce/desafio no `hello` para o token nunca trafegar.
- O app só aceita conectar em endereços de rede local/privada (RFC1918, link-local, loopback, `.local`) — mitiga o envio acidental do código/token a um host da internet por QR/digitação errada.
- Android 14+: a captura de tela usa um único `VirtualDisplay`; ao girar o aparelho o quadro **não é recriado** (o sistema proíbe um segundo `createVirtualDisplay` no mesmo `MediaProjection`) e pode ficar com faixas pretas — o celular compensa no mapeamento de coordenadas.

## Segurança (resumo)

- Viewer e página só em loopback; celular só entra com código (uso único, 5 min, rate limit) ou token pareado.
- Tokens são guardados no Deskbox apenas como hash SHA-256 (`phones.json` em `userData`), fora do `deskbox-config.json` — **nunca** exportados nem sincronizados.
- O tráfego na LAN não é criptografado na sinalização (ws://); o vídeo/DataChannel WebRTC é criptografado (DTLS-SRTP). Evitar redes Wi-Fi públicas/não confiáveis.
