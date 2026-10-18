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

## Revisão de segurança (correções aplicadas)

Uma revisão de código (`/code-review`, alto esforço) sobre a senha mestre e o proxy encontrou dois problemas reais antes de irem pra produção:

1. **Bypass da senha mestre**: trancar o app só desanexava o `BrowserView` (escondia visualmente), mas `getEnrichedState()` continuava devolvendo a lista completa de serviços/workspaces/proxy por IPC, e nenhum handler (`addService`, `removeService`, `selectService` etc., incluindo os acionados pelos atalhos de teclado Ctrl+1-9/Tab) verificava se o app estava trancado antes de mutar o estado. Alguém com DevTools aberto (ou só usando os atalhos) podia ler e alterar tudo mesmo com a tela de bloqueio em cima. Corrigido: `getEnrichedState()` devolve uma versão sanitizada (sem nomes/URLs/proxy) enquanto trancado, e todo método que muta estado ou é sensível (`addService`, `removeService`, `reorderServices`, `selectService`, `setTheme`, `addWorkspace`, `removeWorkspace`, `selectWorkspace`, `setPassword`, `setProxy`, `getMemoryUsage`) agora recusa a operação com `this.locked` ativo — os atalhos de teclado passam pelos mesmos métodos, então ficam cobertos de graça.
2. **Race condition no proxy**: a promise de `session.setProxy()` em `createViewForInstance` não tinha `.catch()` e podia chamar `loadURL` num `BrowserView` já destruído (ex.: serviço removido ou workspace apagado logo após ser criado, antes da promise resolver) — gerava unhandled rejection e podia tentar `loadURL` num webContents morto. Corrigido com `.catch()` (loga em vez de deixar unhandled) e `webContents.isDestroyed()` antes do `loadURL`.

## Otimização de tamanho do build

Pedido explícito de compactar o build mantendo qualidade. Números reais medidos num `.deb` gerado localmente:

| Antes | Depois | |
|---|---|---|
| `out/main/index.js`: 27,6 KB | 15,2 KB | não minificado → minificado (`-45%`) |
| `out/preload/index.js`: 2,07 KB | 1,40 KB | idem |
| App instalado (unpacked): ~268 MB | 229 MB | locales cortados (`-39 MB`) |
| `.deb` final: 72,4 MB | 65,8 MB | locales + `compression: maximum` |

- **`electron.vite.config.ts`**: `build.minify: true` em `main` e `preload` (o `renderer` já era minificado por padrão via Vite+esbuild; `main`/`preload` não eram).
- **`scripts/afterPack.js`** (hook do `electron-builder`): remove os `.pak` de idioma do Chromium que o app não usa, mantendo só `en-US` (fallback universal) e `pt-BR` (idioma da interface) — o Electron empacota ~55 locales por padrão (~40 MB), usados só em menus de contexto nativos (não na UI do app, que é toda React). Validado rodando o build real: "Removidos 53 locales não usados (38.8 MB)".
- **`compression: "maximum"`** no `electron-builder` (`package.json`), em vez do padrão `"normal"` — build um pouco mais lento, instalador mais compacto.
- Sem sourcemaps em produção (já era o padrão do `electron-vite build`, confirmado sem `*.map` em `out/`).

A maior parte do tamanho final (~200 MB) é o próprio binário do Chromium/Electron — não compactável sem trocar de framework, fora do escopo de uma passada de otimização.

## Distribuição sem instalação (ambientes corporativos restritos)

Pedido do usuário: rodar em máquinas corporativas onde instalar programas é bloqueado por política.

- **Windows portable**: `win.target` inclui `"portable"` além de `"nsis"` (`package.json`) — gera um `.exe` avulso que roda direto, sem instalador, sem elevação de admin, sem tocar no registro. Funciona de pasta local ou pendrive.
- **Dados portáteis de verdade**: quando rodando via o build portable, o electron-builder expõe a variável de ambiente `PORTABLE_EXECUTABLE_DIR` (pasta onde está o `.exe`). `src/main/index.ts` detecta isso e redireciona `app.setPath('userData', ...)` pra uma pasta `DeskboxData` ao lado do executável, em vez de `%APPDATA%` — configuração e sessões de cada serviço (login do WhatsApp, Gmail etc., via `session.fromPartition`) ficam dentro dessa pasta. Resultado: nada é gravado no computador usado, e o mesmo pendrive mantém os logins ao trocar de máquina. Tem que rodar antes de qualquer leitura de `userData`, por isso fica logo no topo do arquivo, antes da instância de `Store`.
- **Linux**: o `AppImage` (já gerado desde o início do projeto) já é inerentemente portátil — um único arquivo, `chmod +x` e roda, sem instalação.
- **Por que não "instalar pelo navegador"**: o Deskbox embute os serviços (WhatsApp Web, Gmail, Slack...) dentro da própria janela via `BrowserView`. Isso só é possível num app desktop nativo — os próprios serviços bloqueiam ser carregados dentro de outro site/iframe (`X-Frame-Options`/CSP `frame-ancestors`), exatamente pra impedir esse tipo de embutimento (é uma proteção deles contra clickjacking/phishing). Não há como contornar isso de dentro do navegador sem um proxy reverso dedicado por serviço, fora de escopo.

## Fora do escopo (próximas versões)
- CSS/JS customizado por serviço.
- Proxy por serviço (hoje é só global).
- Sincronização de configuração entre dispositivos (conta Deskbox) — decisão de arquitetura em aberto (backend próprio? Supabase/Firebase? sync via arquivo?).
- Criptografia local dos dados de sessão (hoje a senha mestre é só uma tela de privacidade, não criptografa os dados salvos em disco).
- Auto-update.
- Assinatura de código para distribuição (macOS/Windows).
