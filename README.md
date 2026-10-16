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

- Catálogo com ~20 serviços populares (WhatsApp, Telegram, Slack, Discord, Gmail, Outlook, Teams, Notion, Trello, etc.) + opção de adicionar qualquer site customizado.
- Sidebar com ícones dos serviços adicionados, reordenável por arrastar-e-soltar.
- Sessão isolada por serviço/instância — dá para adicionar o mesmo serviço mais de uma vez (ex.: duas contas de Gmail).
- Badge de não lidos por serviço (detectado a partir do título da aba) agregado no ícone do app.
- **Workspaces**: agrupe serviços em espaços nomeados (ex.: "Trabalho", "Pessoal") e alterne entre eles pelo switcher no topo da sidebar.
- **Hibernação automática**: serviços inativos por mais de 10 minutos são descarregados da memória (a sessão continua salva); reabrir reativa sob demanda. Ícones hibernados aparecem esmaecidos.
- Tema claro/escuro para a interface do Deskbox.
- Empacotamento via `electron-builder` (AppImage/deb no Linux, dmg no macOS, nsis no Windows).

## Roadmap

Ver seção "Fora do escopo" em `docs/deskbox-spec.md`: CSS/JS customizado por serviço, sincronização entre dispositivos, bloqueio por senha mestre, auto-update, busca rápida (command palette), ícones customizados e assinatura de código.
