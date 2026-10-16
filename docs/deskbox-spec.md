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
- **Empacotamento**: configuração do `electron-builder` em `package.json` (`build`), com scripts `npm run dist` / `dist:mac` / `dist:win` / `dist:linux`. Validado localmente com `electron-builder --linux dir` (build sem empacotador externo). Falta: ícones customizados (`build/icon.{png,icns,ico}` — hoje usa o ícone padrão do Electron) e assinatura de código para macOS/Windows.

## Fora do escopo (próximas versões)
- CSS/JS customizado por serviço.
- Sincronização de configuração entre dispositivos (conta Deskbox).
- Bloqueio por senha mestre / criptografia local.
- Auto-update.
- Busca rápida (command palette) entre serviços.
- Ícones de app customizados e assinatura de código para distribuição.
