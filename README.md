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

## Tamanho do build

O empacotador corta os ~55 idiomas do Chromium que o app não usa (mantém só `en-US`/`pt-BR`) e minifica `main`/`preload` — ver detalhes e números em `docs/deskbox-spec.md` § "Otimização de tamanho do build".

## Rodar sem instalar (Windows portable / Linux AppImage)

Pra máquinas corporativas onde instalar programas é bloqueado: o build Windows gera, além do instalador, um `.exe` portátil (`win.target: ["nsis", "portable"]`) que roda direto sem instalação, sem admin, sem tocar no registro — e guarda config/sessões numa pasta ao lado do próprio `.exe` em vez de `%APPDATA%`, então um pendrive carrega tudo entre computadores. No Linux, o `AppImage` já é portátil por natureza. Detalhes em `docs/deskbox-spec.md` § "Distribuição sem instalação".

## Roadmap

Ver seção "Fora do escopo" em `docs/deskbox-spec.md`: CSS/JS customizado por serviço, proxy por serviço, sincronização entre dispositivos, criptografia local, auto-update e assinatura de código.
