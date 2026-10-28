# Deskbox

Organize seus apps de mensagem e produtividade (WhatsApp, Gmail, Slack, Telegram, Notion, etc.) em um único app desktop, inspirado no [Rambox](https://rambox.app).

Veja a análise do produto de referência em [`docs/analise-rambox.md`](docs/analise-rambox.md) e a spec do MVP em [`docs/deskbox-spec.md`](docs/deskbox-spec.md).

## Stack

- Electron + React + TypeScript, orquestrado via [electron-vite](https://electron-vite.org).
- Cada serviço roda em um `BrowserView` com sessão isolada (`persist:deskbox-<id>`), permitindo múltiplas contas do mesmo app.

## Desenvolvimento

```bash
npm install
npm run dev        # app em modo desenvolvimento (hot reload do renderer)
npm run typecheck  # checagem de tipos (main, preload, renderer)
npm test           # testes (sync, criptografia, servidor do celular) — Node puro, sem display
npm run e2e        # ponta a ponta com o Electron de verdade (CSS/JS, proxy por serviço, viewer WebRTC); precisa de xvfb no Linux
npm run build      # build de produção para out/
npm run dist       # empacota o app da plataforma atual (electron-builder) em release/
npm run dist:mac   # empacota .dmg (precisa rodar em macOS)
npm run dist:win   # empacota .exe/nsis (precisa rodar em Windows, ou com Wine no Linux)
npm run dist:linux # empacota AppImage + .deb
```

> Este ambiente de desenvolvimento (sandbox headless, sem display) não permite validar a interface visualmente. `npm run typecheck` e `npm run build` foram validados aqui; teste `npm run dev` numa máquina com display antes de considerar pronto para uso.

## Funcionalidades

- Catálogo com ~30 serviços populares (WhatsApp, WhatsApp Business, Telegram, Slack, Discord, Gmail, Outlook, Teams, Notion, Trello, Claude, ChatGPT, Gemini, GitHub, Figma, etc.) + opção de adicionar qualquer site customizado.
- Sidebar com ícones dos serviços adicionados, reordenável por arrastar-e-soltar.
- Sessão isolada por serviço/instância — dá para adicionar o mesmo serviço mais de uma vez (ex.: duas contas de Gmail).
- Badge de não lidos por serviço (detectado a partir do título da aba) agregado no ícone do app.
- **Workspaces**: agrupe serviços em espaços nomeados (ex.: "Trabalho", "Pessoal") e alterne entre eles pelo switcher no topo da sidebar.
- **Hibernação automática**: serviços inativos por mais de 10 minutos são descarregados da memória (a sessão continua salva); reabrir reativa sob demanda. Ícones hibernados aparecem esmaecidos.
- Tema de 3 estados (sistema/claro/escuro) para a interface do Deskbox.
- Atalhos de teclado: `Ctrl/Cmd+1..9` pula pro N-ésimo serviço, `Ctrl/Cmd+Tab` (+`Shift` pra voltar) cicla entre eles, `Ctrl/Cmd+K` abre o command palette — funcionam mesmo com um serviço em foco.
- Command palette: busca unificada por serviços, workspaces e ações rápidas.
- Indicador de memória por serviço (tooltip) e total agregado na sidebar, pra ver o ganho real da hibernação.
- Empacotamento via `electron-builder` (AppImage/deb no Linux, dmg no macOS, nsis no Windows), com ícone customizado próprio (`build/icon.{png,ico,icns}`).
- **Senha mestre**: tranca o app com uma tela de bloqueio (hash salgado, nunca em texto puro); botão de "trancar agora" e definir/trocar/remover senha no modal de Configurações (ícone de engrenagem na sidebar).
- **Proxy configurável**: regras de proxy globais (`http=...;https=...`) aplicadas a todas as sessões, também pelo modal de Configurações.
- **Hibernação configurável** (5/10/30 min ou nunca) e **exportar/importar configuração** (serviços, workspaces, tema, proxy — sem senha nem logins), ambos no modal de Configurações.
- Arraste um serviço até um workspace na sidebar pra **movê-lo** de workspace. Ícone mostra um spinner enquanto a página carrega (ex.: saindo de hibernação).
- Empty state com chips de adição rápida dos apps mais populares, e um cartão de boas-vindas dispensável no primeiro uso.
- Toasts discretos de confirmação pra ações como salvar senha/proxy/hibernação.
- **Bandeja do sistema**: fechar a janela pode minimizar pra bandeja em vez de encerrar (as sessões continuam rodando), com opção de iniciar com o sistema e/ou já minimizado — tudo no modal de Configurações.
- **Notificações nativas** de mensagem nova quando o Deskbox está em segundo plano (clique na notificação abre o serviço direto); pode ser desligado nas Configurações.
- **Fixar serviço** (clique direito no ícone → "Fixar"): aquele serviço nunca hiberna sozinho, mesmo com a hibernação automática ativa.
- **Adicionar outra conta** direto pelo clique direito no ícone do serviço, sem precisar abrir o catálogo completo de novo.
- Ícone de serviço personalizado: ao adicionar um site customizado, dá pra informar uma URL de ícone própria em vez de depender do favicon automático.
- Indicador visual de onde o item vai cair ao reordenar a sidebar por arrastar-e-soltar.
- Cada workspace tem uma cor própria (determinística, sem precisar configurar nada) pra diferenciar mais rápido no switcher.
- **Densidade da sidebar** (confortável/compacta) ajustável nas Configurações, pra quem tem muitos serviços abertos.
- **CSS, JavaScript e proxy por serviço** (clique direito no ícone → Configurar): injeta CSS/JS a cada carregamento e roteia só aquele serviço por um proxy próprio (`direct://` ignora o global). JS que vem de outro dispositivo/arquivo importado **só roda depois que você revisa e salva** neste computador.
- **Sincronização entre dispositivos** por uma pasta que você já sincroniza (Dropbox, OneDrive, Google Drive, Syncthing…): serviços, workspaces, tema e CSS/JS iguais em todos os computadores, com criptografia opcional (AES-256-GCM + scrypt). Sem conta e sem servidor. Logins e proxies **não** sincronizam.
- **Auto-update** (instalador Windows e AppImage Linux; o portátil só avisa) via GitHub Releases — ver [`docs/release.md`](docs/release.md).
- **Controle de celular Android** dentro de um serviço do Deskbox: espelha a tela do celular e deixa tocar, arrastar e digitar (direto no teclado do computador), tudo na rede local (WebRTC). Precisa do app **Deskbox Celular** no Android. Dois jeitos de conectar: pelo QR (o celular conecta no computador) ou **"Conectar pelo celular"** (o computador conecta no celular — funciona no Deskbox portátil sem administrador e com firewall bloqueando conexões de entrada). Veja [`android/README.md`](android/README.md) e [`docs/phone-protocol.md`](docs/phone-protocol.md).

## Tamanho do build

O empacotador corta os ~55 idiomas do Chromium que o app não usa (mantém só `en-US`/`pt-BR`), remove o arquivo de licenças do Chromium (texto legal sem efeito em runtime — segue público em `chrome://credits`) e minifica `main`/`preload` — ver detalhes e números em `docs/deskbox-spec.md` § "Otimização de tamanho do build". O build Windows no CI gera o instalador completo (`Deskbox-<versão>-setup.exe`) e a versão portátil (`Deskbox-<versão>-portable.exe`) como dois artefatos separados, pra quem só precisa de um não baixar o outro.

## Rodar sem instalar (Windows portable / Linux AppImage)

Pra máquinas corporativas onde instalar programas é bloqueado: o build Windows gera, além do instalador, um `.exe` portátil (`win.target: ["nsis", "portable"]`) que roda direto sem instalação, sem admin, sem tocar no registro — e guarda config/sessões numa pasta ao lado do próprio `.exe` em vez de `%APPDATA%`, então um pendrive carrega tudo entre computadores. No Linux, o `AppImage` já é portátil por natureza. Detalhes em `docs/deskbox-spec.md` § "Distribuição sem instalação".

## Roadmap

Ver seção "Fora do escopo" em `docs/deskbox-spec.md`: criptografia local dos dados de sessão, TLS com fingerprint fixado na sinalização do celular, controle de celular fora da rede local (relay/TURN) e iPhone.

**Assinatura de código**: o pipeline já está pronto (`scripts/ci-build.mjs`, `docs/release.md`), mas depende de **um certificado seu** cadastrado nos segredos do GitHub — sem ele os builds saem sem assinatura e o SmartScreen avisa.
