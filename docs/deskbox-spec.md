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
- **Ícones do app**: `build/icon.png` (1024×1024, master), `build/icon.ico` (Windows, multi-resolução) e `build/icon.icns` (macOS, multi-resolução) gerados a partir de um design próprio (dois cartões arredondados sobrepostos — cinza ao fundo, azul de destaque à frente — sobre fundo escuro, ecoando a paleta da sidebar). Script de geração ficou fora do repo (uso pontual via Pillow). `BrowserWindow` resolve o ícone em runtime a partir de `out/renderer/favicon.png` (copiado para dentro do `app.asar` por estar em `files: ["out/**/*"]`), com fallback para `build/icon.png` em `npm run dev` (onde `out/renderer` não existe, pois o renderer é servido pelo Vite dev server). **Atenção**: `build/` nunca é empacotado — só serve de fonte pro `electron-builder` gerar os ícones da plataforma — então nunca usar `build/icon.png` como caminho único em runtime. Favicon do renderer em `src/renderer/public/favicon.png`.

## Revisão pós-implementação (correções aplicadas)

Uma revisão de código (`/code-review`) sobre o commit dos ícones + auditoria manual do processo main encontraram e corrigiram dois bugs reais antes deles chegarem a produção:

1. **Ícone não aparecia em build Linux empacotado**: `BrowserWindow` lia `build/icon.png`, mas esse diretório não é copiado para os recursos do app (`files: ["out/**/*"]` no `electron-builder`), então `existsSync` sempre falhava em runtime empacotado. Corrigido para usar `out/renderer/favicon.png` (que *é* empacotado) como fonte primária. Validado extraindo o `app.asar` de um build `.deb` real e conferindo que `out/renderer/favicon.png` existe no caminho relativo esperado a partir de `out/main/index.js`.
2. **Crash ao reabrir janela no macOS**: `createMainWindow()` recriava `Store` + `ServicesManager` + todos os `ipcMain.handle(...)` a cada chamada. No macOS, fechar todas as janelas não encerra o app (comportamento padrão), e `activate` (clique no ícone do dock) chama `createMainWindow()` de novo — `ipcMain.handle` lança erro ao registrar um segundo handler pro mesmo canal, interrompendo a criação da janela no meio, além de vazar o `setInterval` de hibernação da instância antiga (que continuaria rodando e tentando mandar IPC pra uma janela já destruída). Corrigido: `Store`/`ServicesManager`/`ipcMain.handle` agora são criados uma única vez na vida do app; `createMainWindow()` chama `manager.rebindWindow(novaJanela)` em vez de recriar tudo quando o manager já existe.
3. **Modal invisível atrás do serviço ativo** (crítico): um `BrowserView` do Electron sempre renderiza numa camada nativa por cima do DOM da janela, fora do stacking context da página — nenhum `z-index` do CSS resolve isso. `AddServiceModal` e `NewWorkspaceModal` só eram visíveis no estado vazio inicial (sem nenhum `BrowserView` anexado); assim que havia um serviço ativo, clicar em "+" não mostrava nada (o modal renderizava, só que escondido atrás do conteúdo do serviço). Corrigido com `ServicesManager.setOverlayOpen(bool)`: o processo principal desanexa o `BrowserView` (`window.setBrowserView(null)`) enquanto qualquer modal do renderer estiver aberto, e reanexa ao fechar. `App.tsx` sincroniza isso via IPC (`deskbox:set-overlay-open`) sempre que `modalOpen || workspaceModalOpen` mudar.

## Funcionalidades adicionais pós-MVP

- **Atalhos de teclado globais**: `Ctrl/Cmd+1`..`9` pula direto pro N-ésimo serviço do workspace ativo; `Ctrl/Cmd+Tab` / `Ctrl/Cmd+Shift+Tab` cicla entre eles; `Ctrl/Cmd+K` abre o command palette. Implementado via `before-input-event` em cada `WebContents` (janela principal + cada `BrowserView`) — ouvir `keydown` só no React não bastaria, já que cada serviço tem seu próprio foco de teclado nativo, independente do DOM da sidebar.
- **Tema de 3 estados**: o botão de tema agora cicla `sistema → claro → escuro → sistema` (antes alternava só claro/escuro, sem como voltar a seguir o SO).
- **Command palette** (`Ctrl/Cmd+K` ou botão de lupa no rodapé da sidebar): busca unificada por serviços (de qualquer workspace, não só o ativo), workspaces e ações rápidas (adicionar serviço, criar workspace). Selecionar um serviço de outro workspace troca `activeWorkspaceId` junto (correção necessária em `ServicesManager.selectService`, que antes só atualizava `activeInstanceId` e deixava o estado inconsistente nesse caso).
- **Indicador de uso de memória**: `ServicesManager.getMemoryUsage()` cruza o PID de cada `BrowserView` (`webContents.getOSProcessId()`) com `app.getAppMetrics()` pra estimar o RAM por serviço. Renderer faz polling a cada 5s; aparece no tooltip de cada ícone e como total agregado no rodapé da sidebar — só conta serviços ativos (hibernados não têm processo), tornando visível o ganho real da hibernação.

## Fase 3 — Recursos avançados

- **Senha mestre / tela de bloqueio**: hash salgado via `crypto.scryptSync` (`src/main/password.ts`, comparação com `timingSafeEqual`) — nunca guarda a senha em texto puro, e o hash (`passwordHash`) nunca sai do processo principal (o renderer só recebe `hasPassword: boolean`, ver `RendererState` em `src/shared/types.ts`). O app começa trancado em todo boot se houver senha configurada; trancar/destravar reusa o mesmo mecanismo de desanexar o `BrowserView` já usado pros modais (`ServicesManager.reattachActiveViewIfAllowed`). Botão de "Trancar agora" na sidebar (só aparece se há senha) e gestão completa (definir/trocar/remover) no modal de Configurações. **Limitação conhecida**: sem senha esquecida/recuperação — a única saída é apagar o arquivo de config (perde também os serviços), deixado assim de propósito porque é só uma tela de privacidade local, não uma defesa contra um atacante sofisticado.
- **Proxy configurável**: global por enquanto (um único `proxyRules` pra todas as sessões — não há granularidade por serviço ainda). Aplicado via `session.setProxy()` na sessão default e em cada `BrowserView` já existente; novas sessões de serviço aplicam o proxy atual antes do primeiro `loadURL` (evita vazar a primeira requisição fora do proxy). Configurável no modal de Configurações.

## Fora do escopo (próximas versões)
- CSS/JS customizado por serviço.
- Proxy por serviço (hoje é só global).
- Sincronização de configuração entre dispositivos (conta Deskbox) — decisão de arquitetura em aberto (backend próprio? Supabase/Firebase? sync via arquivo?).
- Criptografia local dos dados de sessão (hoje a senha mestre é só uma tela de privacidade, não criptografa os dados salvos em disco).
- Auto-update.
- Assinatura de código para distribuição (macOS/Windows).
