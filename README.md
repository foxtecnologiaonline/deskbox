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
```

> Este ambiente de desenvolvimento (sandbox headless, sem display) não permite validar a interface visualmente. `npm run typecheck` e `npm run build` foram validados aqui; teste `npm run dev` numa máquina com display antes de considerar pronto para uso.

## Funcionalidades do MVP

- Catálogo com ~20 serviços populares (WhatsApp, Telegram, Slack, Discord, Gmail, Outlook, Teams, Notion, Trello, etc.) + opção de adicionar qualquer site customizado.
- Sidebar com ícones dos serviços adicionados, reordenável por arrastar-e-soltar.
- Sessão isolada por serviço/instância — dá para adicionar o mesmo serviço mais de uma vez (ex.: duas contas de Gmail).
- Badge de não lidos por serviço (detectado a partir do título da aba) agregado no ícone do app.
- Tema claro/escuro para a interface do Deskbox.

## Roadmap (pós-MVP)

Ver seção "Fora do escopo do MVP" em `docs/deskbox-spec.md`: workspaces, hibernação de apps inativos, CSS/JS customizado por serviço, sincronização entre dispositivos, bloqueio por senha mestre, empacotamento/distribuição.
