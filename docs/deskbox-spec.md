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

## Fora do escopo do MVP (próximas versões)
- Workspaces (agrupar serviços em espaços nomeados).
- Hibernação real de serviços inativos (descarregar processo).
- CSS/JS customizado por serviço.
- Sincronização de configuração entre dispositivos (conta Deskbox).
- Bloqueio por senha mestre / criptografia local.
- Empacotamento/distribuição (electron-builder) e auto-update.
