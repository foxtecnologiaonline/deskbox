# Deskbox — Spec do MVP

Baseado na análise em `docs/analise-rambox.md`. Decisões de direção confirmadas com o usuário:

- **Stack:** Electron + React + TypeScript (via `electron-vite`).
- **Escopo do MVP:** núcleo mínimo — catálogo pequeno (~18-20 serviços populares) + site customizado, sidebar, sessão isolada por serviço, notificações nativas (via badge de não lidos por título), tema claro/escuro. Workspaces e hibernação ficam para depois do MVP.

## Arquitetura

```
┌──────────────────────────────────────────────┐
│ BrowserWindow (único)                         │
│ ┌────────┬─────────────────────────────────┐ │
│ │Sidebar │ BrowserView ativo (overlay)      │ │
│ │(React) │ sessão isolada: persist:<id>     │ │
│ │ 72px   │                                  │ │
│ └────────┴─────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

- A janela principal carrega a sidebar em React (processo de renderização).
- Cada serviço adicionado vira um `BrowserView` com `partition: persist:deskbox-<instanceId>` (cookies/local storage isolados — permite múltiplas contas do mesmo serviço).
- Apenas um `BrowserView` fica anexado/visível por vez (troca via `setBrowserView`); os demais permanecem instanciados em memória (hibernação real fica para uma v2).
- Um preload injetado em cada serviço observa mudanças no `document.title` (padrão comum `(N) Nome do app`) e envia a contagem para o processo principal, que agrega e expõe como badge por ícone + badge total no dock/taskbar (`app.setBadgeCount`, suportado em macOS/Linux).
- Configuração (lista de serviços, ordem, tema, serviço ativo) persistida em JSON em `app.getPath('userData')/deskbox-config.json`.

## Estrutura de pastas

```
src/
  main/        processo principal (ciclo de vida do app, gestão de BrowserViews, store)
  preload/     preload da janela principal (API ponte) + preload injetado em cada serviço
  renderer/    UI React (sidebar, modal de catálogo, tema)
  shared/      tipos e constantes de IPC compartilhados
```

## Implementado após o MVP

- **Workspaces**: serviços pertencem a um workspace (`workspaceId`); switcher na sidebar (pills circulares com iniciais) permite criar, trocar e remover workspaces. Sempre existe ao menos um (`Geral`, criado por padrão). Trocar de workspace troca o `BrowserView` exibido e filtra a lista de serviços mostrada.
- **Hibernação de serviços inativos**: a cada 60s uma varredura destrói (`webContents.close()`) o `BrowserView` de qualquer serviço que não esteja ativo há mais de 10 minutos (`HIBERNATE_AFTER_MS` em `src/main/services-manager.ts`). A sessão (`persist:`) permanece salva em disco, então reabrir o serviço restaura o login. Serviços hibernados aparecem com ícone esmaecido na sidebar; clicar neles recria o `BrowserView` sob demanda. No `init()`, apenas o serviço ativo é carregado — os demais começam hibernados.
- **Empacotamento**: configuração do `electron-builder` em `package.json` (`build`), com scripts `npm run dist` / `dist:mac` / `dist:win` / `dist:linux`. Validado localmente com `electron-builder --linux dir` e com um `.deb` real (`--linux deb`), confirmando que o pacote, o atalho `.desktop` (`Icon=deskbox`) e `/usr/share/icons/hicolor/1024x1024/apps/deskbox.png` ficam corretos. Falta: assinatura de código para macOS/Windows.
- **Ícones do app**: `build/icon.png` (1024×1024, master), `build/icon.ico` (Windows, multi-resolução) e `build/icon.icns` (macOS, multi-resolução) gerados a partir de um design próprio (dois cartões arredondados sobrepostos — cinza ao fundo, azul de destaque à frente — sobre fundo escuro, ecoando a paleta da sidebar). Script de geração ficou fora do repo (uso pontual via Pillow); para regenerar a partir de um novo design, ver `docs/deskbox-spec.md` nesta seção. `BrowserWindow` usa `build/icon.png` em dev (`src/main/index.ts`); em build empacotado o ícone vem do próprio pacote da plataforma. Favicon do renderer em `src/renderer/public/favicon.png`.

## Fora do escopo (próximas versões)
- CSS/JS customizado por serviço.
- Sincronização de configuração entre dispositivos (conta Deskbox).
- Bloqueio por senha mestre / criptografia local.
- Auto-update.
- Busca rápida (command palette) entre serviços.
- Ícones de app customizados e assinatura de código para distribuição.
