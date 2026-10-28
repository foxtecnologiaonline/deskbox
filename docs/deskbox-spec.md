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

### Segunda passada (pedido explícito de "menor tamanho possível, sem perder qualidade")

Antes de tocar em qualquer coisa, gerei um `.deb` real e medi `du -sh` em cada item do pacote (`release/linux-unpacked`) pra achar o que ainda sobrava de seguro cortar, em vez de chutar. Achado: o binário `deskbox` (motor do Chromium/Electron) sozinho é **178 MB** dos ~220 MB totais — isso é a base irredutível da stack escolhida. O resto, em ordem de peso: `icudtl.dat` (10 MB, dados de Unicode/ICU — precisa de um build customizado do Electron a partir do código-fonte pra reduzir, fora de escopo), `LICENSES.chromium.html` (8,8 MB), `libGLESv2.so`/`resources.pak`/`app.asar`/`libvk_swiftshader.so`/`libffmpeg.so` (todos necessários pra renderização, mídia e fallback de GPU — removê-los quebraria funcionalidade real).

- **Removido `LICENSES.chromium.html` (8,8 MB) via `afterPack.js`**: é só texto de atribuição de licenças open-source do Chromium, sem nenhum efeito em runtime. O texto completo continua público em qualquer instalação do Chromium (`chrome://credits`) e em chromium.org, então remover a cópia duplicada do pacote não tira o acesso à atribuição — só o peso morto. Validado: unpacked caiu de 229 MB pra 220 MB.
- **Por que o `.deb` final não encolheu no mesmo tanto** (ficou em ~66 MB, praticamente igual ao anterior): `LICENSES.chromium.html` é um arquivo de texto puro, que a compressão `maximum` já espremia bastante antes de remover — a economia de 8,8 MB no disco do usuário (instalado) não se traduz 1:1 no tamanho do instalador baixado, porque texto comprime muito melhor que binário. Ainda assim, vale: menos espaço ocupado depois de instalado é uma otimização real, só não é a mesma métrica do "download".
- **`nsis.artifactName`**: agora `Deskbox-<versão>-setup.exe` (antes usava o nome padrão do electron-builder, com espaço). Também dá nome previsível pra separar os dois instaladores Windows em artefatos distintos no CI (ver abaixo).
- **`nsis.differentialPackage: false`**: desliga a geração do `.blockmap` (usado só por atualização diferencial, que o Deskbox não tem — sem auto-update, ver "Fora do escopo"). Não afeta o tamanho do `.exe` entregue (o `.blockmap` nunca era enviado como artefato), só evita trabalho/arquivo desnecessário no `release/` local.
- **Dois artefatos separados no CI** (`build-windows.yml`): em vez de um `.zip` só com os dois `.exe` juntos, agora o workflow sobe `Deskbox-Setup` e `Deskbox-Portable` como artefatos distintos — quem só precisa de um baixa só o que precisa, sem carregar o outro.
- **Conclusão**: o essencial do tamanho (Chromium + V8 + Node.js + ICU) é estrutural da escolha Electron e não dá pra reduzir mais sem comprometer qualidade ou trocar de framework por completo (reescrita, fora de escopo). As otimizações seguras já aplicadas (locales, minificação, licenças, compressão máxima) esgotam o que se pode cortar sem abrir mão de funcionalidade.

## Distribuição sem instalação (ambientes corporativos restritos)

Pedido do usuário: rodar em máquinas corporativas onde instalar programas é bloqueado por política.

- **Windows portable**: `win.target` inclui `"portable"` além de `"nsis"` (`package.json`) — gera um `.exe` avulso que roda direto, sem instalador, sem elevação de admin, sem tocar no registro. Funciona de pasta local ou pendrive.
- **Dados portáteis de verdade**: quando rodando via o build portable, o electron-builder expõe a variável de ambiente `PORTABLE_EXECUTABLE_DIR` (pasta onde está o `.exe`). `src/main/index.ts` detecta isso e redireciona `app.setPath('userData', ...)` pra uma pasta `DeskboxData` ao lado do executável, em vez de `%APPDATA%` — configuração e sessões de cada serviço (login do WhatsApp, Gmail etc., via `session.fromPartition`) ficam dentro dessa pasta. Resultado: nada é gravado no computador usado, e o mesmo pendrive mantém os logins ao trocar de máquina. Tem que rodar antes de qualquer leitura de `userData`, por isso fica logo no topo do arquivo, antes da instância de `Store`.
- **Linux**: o `AppImage` (já gerado desde o início do projeto) já é inerentemente portátil — um único arquivo, `chmod +x` e roda, sem instalação.
- **Por que não "instalar pelo navegador"**: o Deskbox embute os serviços (WhatsApp Web, Gmail, Slack...) dentro da própria janela via `BrowserView`. Isso só é possível num app desktop nativo — os próprios serviços bloqueiam ser carregados dentro de outro site/iframe (`X-Frame-Options`/CSP `frame-ancestors`), exatamente pra impedir esse tipo de embutimento (é uma proteção deles contra clickjacking/phishing). Não há como contornar isso de dentro do navegador sem um proxy reverso dedicado por serviço, fora de escopo.

## Leva de melhorias (visual/performance/UI/UX)

9 das 10 sugestões dadas ao usuário foram implementadas nessa leva (a 10ª, ícone de marca real, segue pendente — precisa de ativos visuais próprios, não dá pra inventar uma "marca real"):

- **Lazy-load de favicons**: `loading="lazy"` em toda `<img>` de favicon (Sidebar, catálogo, command palette, empty state).
- **Polling de memória pausado quando oculto**: `App.tsx` escuta `document.visibilitychange` e para o `setInterval` de `getMemoryUsage()` enquanto a janela está minimizada/oculta.
- **Sistema de toast**: `src/renderer/src/toast.ts` (pub/sub mínimo) + `<ToastHost/>` montado uma vez em `App.tsx`; qualquer componente chama `showToast(msg)` sem precisar de prop drilling. Substituiu as mensagens de sucesso inline do modal de Configurações (erros continuam inline, perto do campo).
- **Hibernação configurável**: `DeskboxState.hibernateAfterMinutes` (5/10/30/nunca), editável no modal de Configurações; `sweepHibernation()` lê o valor em vez de um `HIBERNATE_AFTER_MS` fixo.
- **Exportar/importar configuração**: `dialog.showSaveDialog`/`showOpenDialog` no main process + `ServicesManager.exportConfig()`/`importConfig()`. Exporta serviços/workspaces/tema/proxy/hibernação — nunca a senha, nunca os logins de cada serviço (ficam nas partições de sessão, fora do JSON). Import valida forma (instanceId/url/partition como string, workspaceId existente) e aplica tudo dentro de um try/catch, pra um JSON malformado virar erro tratado em vez de deixar o processo principal instável.
- **Mover serviço entre workspaces por arrastar**: `WorkspaceSwitcher` aceita `onDrop` nos pills; `ServicesManager.moveServiceToWorkspace()` atualiza `workspaceId`/`order` e, se o serviço movido era o ativo, escolhe um irmão do workspace atual como novo ativo (não "segue" o serviço pro destino).
- **Spinner de carregamento no ícone**: hooks `did-start-loading`/`did-stop-loading` em cada `BrowserView` alimentam um `Set<instanceId>` (`loadingInstanceIds`), exposto como `ServiceInstance.loading` no estado enviado ao renderer.
- **Empty state mais rico**: chips de adição rápida (WhatsApp, Gmail, Slack, Telegram, Discord, Notion) direto no estado vazio, além do botão pro catálogo completo.
- **Onboarding guiado**: cartão dispensável no primeiro uso (`DeskboxState.onboardingDismissed`), com as 3 dicas principais (adicionar serviço, workspaces, `Ctrl+K`).

## Fora do escopo (próximas versões)
- Criptografia local dos dados de sessão (hoje a senha mestre é só uma tela de privacidade, não criptografa os dados salvos em disco).
- Sinalização do controle de celular com TLS (`wss://`) e fingerprint do certificado fixado no QR — hoje é `ws://` na LAN (ver "Limitações conhecidas" em `docs/phone-protocol.md`).
- Controle de celular fora da rede local (exige servidor de sinalização público + TURN) e iPhone (a Apple não permite controle remoto sem MDM).
- Proxy com autenticação (usuário/senha) por serviço.
- Assinatura de código: o pipeline está pronto (`docs/release.md`), mas precisa de um certificado do dono do projeto.

## Revisão pós-fase-4 (correções aplicadas)

Mais uma passada de `/code-review` (alto esforço, escopo `src/`) sobre tudo construído até aqui encontrou 3 problemas reais:

1. **`exportConfig` não verificava o lock**: diferente de todo outro método sensível (ver "Revisão de segurança" acima), `exportConfig()`/seu handler de IPC não checava `this.locked` — dava pra chamar `window.deskbox.exportConfig()` pelo DevTools e salvar a lista completa de serviços/workspaces/proxy em disco mesmo com a tela de bloqueio em cima. Corrigido: o handler `IPC.EXPORT_CONFIG` em `index.ts` agora recusa com `Destrave o app antes de exportar.` antes de abrir o diálogo de salvar, igual aos outros métodos sensíveis.
2. **Hash de senha síncrono travava o main process**: `password.ts` usava `scryptSync`, que bloqueia a única thread do processo main por ~100ms+ a cada tentativa de destravar ou trocar senha — nesse intervalo a janela não resiza, nenhum IPC responde, e `before-input-event` (atalhos de teclado) para de funcionar em todos os serviços abertos. Corrigido: `password.ts` reescrito com `scrypt` assíncrono (via `util.promisify`), e `unlock()`/`setPassword()` em `services-manager.ts` agora são `async` e aguardam o hash/verificação sem travar o loop de eventos.
3. **Reordenar serviços por arrastar tinha inconsistência de direção**: `handleDrop` em `Sidebar.tsx` calculava a posição de destino (`to`) antes de remover o item arrastado do array, então o item caía *depois* do alvo ao arrastar pra frente mas *antes* do alvo ao arrastar pra trás — comportamento inconsistente dependendo da direção do gesto. Corrigido: o índice de destino agora é recalculado depois de remover o item arrastado, então ele sempre cai imediatamente antes do alvo, nas duas direções.

## Leva 2 de melhorias (bandeja, notificações, pin, catálogo, visual, performance)

10 sugestões pedidas pelo usuário, todas implementadas:

**Praticidade**
- **Bandeja do sistema**: `Tray` criado sob demanda (só se `minimizeToTray` ou `startMinimized` estiverem ativos e o ícone do app tiver sido resolvido) com menu "Abrir Deskbox"/"Sair". Fechar a janela (`close`) faz `preventDefault()` + `hide()` em vez de destruir, quando `minimizeToTray` está ativo — a sessão de cada serviço continua rodando em memória. `launchAtLogin` usa `app.setLoginItemSettings`; `startMinimized` pula o `show()` no `ready-to-show`. Rede de segurança: ambos os comportamentos (fechar pra bandeja, iniciar minimizado) só valem se um `Tray` de fato existir (`&& tray` / `|| !tray`) — sem isso, se o ícone do app não resolvesse (`appIcon` undefined), o usuário ficaria com o app invisível e sem nenhum jeito de reabrir além de matar o processo.
- **Notificações nativas**: `ServicesManager.notifyNewUnread()` dispara um `Notification` do Electron quando o contador de não lidos de um serviço *aumenta* e a janela não está em foco (`window.isFocused()`); clique na notificação foca a janela e seleciona o serviço. Toggle em Configurações (`notificationsEnabled`).
- **Fixar serviço**: campo `pinned` em `ServiceInstance`; `sweepHibernation()` ignora instâncias fixadas. Acessível pelo novo menu de contexto (clique direito no ícone).

**Apps/sites**
- **Adicionar outra conta** pelo menu de contexto: duplica a instância (mesmo `catalogId`, ou nome/URL/ícone se for site personalizado) sem reabrir o catálogo completo.
- **Catálogo ampliado**: Airtable, Miro, Monday.com, Todoist, Evernote, WeChat. Jira/Confluence ficaram de fora de propósito — exigem subdomínio próprio da empresa, então uma URL genérica no catálogo não funcionaria; o caminho certo pra esses é "+ Adicionar site personalizado" com o domínio da própria instância.
- **Ícone de serviço manual**: campo opcional de URL de ícone no formulário de site personalizado (`ServiceInstance.iconUrl`), usado no lugar do favicon automático em toda a UI (sidebar, command palette).

**Visual**
- **Indicador de drop no drag-and-drop**: linha indicadora (`::before`) no ícone sobre o qual o item arrastado está passando.
- **Cor por workspace**: `workspaceColor(id)` (hash determinístico sobre uma paleta fixa de 8 cores) — sem precisar persistir nada nem adicionar UI de escolha; o anel de "ativo" passou a usar `box-shadow` em vez de `border-color` pra não brigar com a cor de fundo do pill.
- **Densidade de sidebar** (confortável/compacta): `sidebarDensity` persistido; `ServicesManager.layout()` calcula a largura do `BrowserView` dinamicamente a partir dela (precisa bater exatamente com a largura do CSS — `72px`/`56px` — senão o conteúdo do serviço fica desalinhado com a sidebar).

**Performance**
- **`broadcastState()` coalescido**: várias mutações de estado síncronas na mesma função (ex.: `setState` + `updateBadge`) geravam um envio de IPC por chamada; agora agenda via `queueMicrotask` e só manda o estado final uma vez por tick.
- **Polling de memória mais leve**: intervalo de `getMemoryUsage()` subiu de 5s pra 15s no `App.tsx`.

### Revisão (correções aplicadas antes do commit)

Uma passada de `/code-review` (alto esforço) sobre esse diff (área de risco: ciclo de vida de janela/tray é terreno já historicamente propenso a bug nesta sessão) encontrou 5 problemas reais:

1. **Menu de contexto com backdrop bloqueando cliques**: o backdrop cobrindo a tela inteira (`position: fixed; inset: 0`) ficava visualmente por cima dos ícones da sidebar, então clicar com o botão direito num ícone *diferente* enquanto outro menu estava aberto só fechava o menu atual (o clique nunca chegava no ícone de baixo) — era preciso clicar direito duas vezes. Corrigido removendo o backdrop e usando um listener de captura em `window` (`mousedown`/`contextmenu`) que só observa se o clique foi fora do menu, sem bloquear o ponteiro — agora um clique direito no ícone B enquanto o menu de A está aberto troca o menu pra B num clique só.
2. **"Abrir Deskbox" no tray não reabria a janela quando `startMinimized` estava ativo**: se a janela tinha sido fechada de verdade (sem `minimizeToTray`) e o app ficou só no tray (por `startMinimized`), clicar em "Abrir Deskbox" recriava a janela mas o `ready-to-show` via `startMinimized: true` e pulava o `show()` — primeiro clique não fazia nada visível. Corrigido com uma flag `forceShowOnReady`, setada antes de recriar a janela por um pedido explícito de abrir.
3. **App ficaria inacessível sem tray**: se `appIcon` não resolvesse (defensivo — não deveria acontecer nesse repo, mas seria catastrófico se acontecesse), `syncTray()` nunca criava o `Tray`, e mesmo assim `minimizeToTray`/`startMinimized` escondiam a janela sem nenhum jeito de reabrir a não ser matar o processo. Corrigido: os dois comportamentos agora checam `tray` (`&& tray` no close, `|| !tray` no ready-to-show) antes de esconder a janela.
4. **URL de ícone manual sem normalização**: o campo de URL do site customizado auto-prefixa `https://` se faltar o protocolo, mas o campo de ícone manual não — um ícone digitado como `exemplo.com/icone.png` virava uma URL relativa à própria página do app (`file://.../icone.png`), sempre quebrada. Corrigido aplicando a mesma normalização.
5. **Argumento `--hidden` morto**: `app.setLoginItemSettings` recebia `args: ['--hidden']` quando "iniciar com o sistema" estava ativo, mas nada no código lê `process.argv` — o argumento nunca influenciava nada (quem decide se a janela aparece no boot é só o `startMinimized` persistido). Removido por ser código morto e enganoso pra quem for ler depois.

## Revisão pós-leva-2 (correções aplicadas)

Mais uma passada de `/code-review` (alto esforço) sobre a leva de bandeja/notificações/pin/menu de contexto encontrou 4 problemas reais — a área de maior risco continua sendo o ciclo de vida de janela/tray, que já tinha gerado bug em rounds anteriores:

1. **`minimizeToTray` bloqueava qualquer saída real do app, não só o botão de fechar**: `isQuitting` só era setado pelo item "Sair" do menu do tray. Saindo por outro caminho (Cmd+Q no macOS, "Sair" pelo Dock, qualquer `app.quit()` que não passasse pelo tray), o handler de `close` via `isQuitting === false` e `minimizeToTray === true` e simplesmente escondia a janela de novo — o app nunca encerrava de fato, só ficava rodando escondido até alguém achar o ícone do tray. Corrigido com `app.on('before-quit', () => { isQuitting = true })`, que cobre qualquer caminho de saída, não só o do menu.
2. **Menu de contexto do serviço podia abrir cortado pela borda da janela**: a posição usava `e.clientX`/`e.clientY` sem nenhum limite — clicar com o botão direito num ícone perto do fim da sidebar (lista comprida de serviços) abria o menu perto da borda inferior, e como `.app-shell` tem `overflow: hidden`, os últimos botões (ex.: "Remover") ficavam cortados e inacessíveis. Corrigido com um clamp simples (`Math.max`/`Math.min`) contra `window.innerWidth`/`innerHeight`, usando a largura/altura reais do CSS do menu como referência (`.context-menu` virou `width: 200px` fixo em vez de `min-width`, pra o clamp bater com o tamanho real renderizado).
3. **Notificação espúria ao adicionar/duplicar um serviço com não lidos pré-existentes**: `handleUnreadMessage` comparava a contagem nova com `service.unreadCount` do estado (que começa em `0` pra toda instância nova). Numa conta restaurada de sessão com mensagens já não lidas antes mesmo de abrir no Deskbox (ex.: WhatsApp com 5 não lidas), a primeira leitura do preload (`count = 5`) era maior que o `0` inicial, e o usuário recebia uma notificação de "mensagem nova" pra mensagens que não eram novas — bem no momento de adicionar a conta. Corrigido com um `Set<instanceId>` (`seenUnreadInstanceIds`) que marca a primeira leitura de cada instância só como linha de base, sem notificar; só a partir da segunda leitura em diante uma contagem maior dispara notificação de verdade. Limpo em `removeService`/`removeWorkspace`/`importConfig` pra não crescer sem limite.
4. **Seis setters quase idênticos** (`toggleServicePinned`, `setSidebarDensity`, `setNotificationsEnabled`, `setMinimizeToTray`, `setLaunchAtLogin`, `setStartMinimized`) repetiam o mesmo bloco de 4 linhas (checar lock → mesclar estado → notificar renderer → devolver estado). Consolidado num helper privado `patchState()` — reduz cada um a uma linha e evita o risco de uma futura 7ª configuração esquecer o `if (this.locked)`.

## Leva 3 — CSS/JS e proxy por serviço, sync, auto-update, assinatura e controle de celular

Seis itens que estavam em "Fora do escopo"/v2. Como esta leva tem muita superfície de segurança (JS injetado em páginas logadas, arquivo de config vindo de fora, servidor na LAN), ela veio acompanhada de **testes automatizados de verdade** (`npm test`: 36 testes; `npm run e2e`: 24 verificações com o Electron real via CDP) e de uma revisão de código antes do commit.

### CSS, JS e proxy por serviço
- `ServiceInstance` ganhou `proxy`, `customCss`, `customJs`, `approvedJsHash`. CSS entra via `insertCSS` e JS via `executeJavaScript` no `dom-ready` (a cada carregamento). Trocar só o CSS troca a folha (`removeInsertedCSS` + `insertCSS`) **sem recarregar**; proxy ou JS recarregam o serviço.
- **Proxy por serviço** sobrepõe o global só naquela partição (`session.setProxy` por `persist:`); `direct://` faz o serviço ignorar o proxy global. Verificado no e2e: a requisição de um serviço passa pelo proxy dele e o outro serviço **não**.
- **Aprovação de JS (decisão de segurança)**: JS personalizado roda dentro da página com a sessão logada, então código que chega por **sync ou importação** nunca executa sozinho. Só roda se `sha256(customJs) === approvedJsHash` — hash local, que **não** é exportado nem sincronizado. Salvar o código pelo modal "Configurar" (depois de revisar) aprova. O ícone mostra ⚠ e o modal um aviso enquanto está pendente.
- Importação e sync validam tudo que vem de fora (`parseSyncPayload`): só URLs `http(s)` (nada de `file://`/`javascript:`), CSS/JS ≤ 200 KB, workspace existente. Isso também fechou uma brecha antiga: o import manual aceitava qualquer string como URL.

### Sincronização entre dispositivos
- **Decisão** (a pergunta "backend próprio? Supabase? arquivo?" estava em aberto): **arquivo numa pasta** que o usuário já sincroniza (Dropbox/OneDrive/Drive/Syncthing). Zero servidor, zero conta, zero custo, e a privacidade fica nas mãos do usuário.
- Arquivo `deskbox-sync.json` com envelope versionado. Criptografia opcional: **AES-256-GCM**, chave por **scrypt** (N=16384, salt aleatório por gravação), cabeçalho (`updatedAt`, `deviceId`) como **AAD** — adulterar a data invalida a autenticação. Parâmetros do KDF vindos do arquivo são limitados (um arquivo hostil não consegue pedir GBs de memória). A senha fica guardada com o cofre do SO (`safeStorage`); sem cofre (Linux sem keyring) o app pede a senha de novo a cada abertura.
- **O que sincroniza**: serviços (nome, URL, workspace, ordem, ícone, fixado, CSS, JS), workspaces, tema, hibernação, densidade, notificações. **O que não**: senha mestre, logins/sessões (ficam em cada dispositivo), proxy global e por serviço (rede do trabalho ≠ casa), bandeja/iniciar com o sistema, serviço ativo, **celulares pareados** (o pareamento é por computador).
- **Conflitos**: *last-writer-wins* pela config inteira (`configUpdatedAt`). O carimbo é **monotônico** (`max(agora, anterior+1)`) para um relógio atrasado não fazer a edição local perder; carimbo a mais de 1 dia no futuro é recusado ("confira o relógio"). Ao ligar o sync numa pasta que já tem config diferente da do dispositivo, o usuário escolhe qual lado vence — nunca sobrescreve em silêncio.
- Escrita atômica (arquivo temporário + `rename`), `fs.watch` + polling de 60 s (clientes de nuvem trocam o arquivo por rename), push com debounce de 2 s, tudo serializado.

### Auto-update
- `electron-updater` + GitHub Releases (`build.publish`). Instalador NSIS e AppImage baixam em segundo plano e instalam ao reiniciar; o **portátil só avisa** (é um `.exe` avulso). Detalhes, requisitos (repo público, tag = versão, macOS só assinado) e o fluxo de release em [`docs/release.md`](release.md).
- **Limite de validação honesto**: o auto-update só se prova ponta a ponta depois de publicar uma release e atualizar a partir de uma versão anterior. O e2e cobre o caminho de desenvolvimento (`unsupported`) e o app empacotado sobe com o módulo no asar.

### Assinatura de código
- `scripts/ci-build.mjs` escolhe o modo pelos segredos: certificado `.pfx` (`WIN_CSC_LINK`), **Azure Trusted Signing**, ou macOS Developer ID + notarização; sem segredos, build sem assinatura com aviso explícito no log. Os workflows verificam a assinatura (`Get-AuthenticodeSignature`) e têm a opção `require_signature`. Guia completo e lista de segredos em [`docs/release.md`](release.md).
- **Não dá pra concluir sem o dono do projeto**: emitir o certificado (pago) e cadastrar os segredos é uma ação dele.

### Controle de celular Android
- Arquitetura da v2 mantida (app companion empurra a tela via `MediaProjection` + `AccessibilityService`, WebRTC, Deskbox como cliente), **somente na LAN** (decisão para a pergunta "local ou relay?": local primeiro; relay exige servidor público + TURN, é outra decisão de infraestrutura). Protocolo em [`docs/phone-protocol.md`](phone-protocol.md).
- No Deskbox: `PhoneServer` (HTTP + WebSocket, porta 47890+) faz pareamento (código de 6 dígitos, 5 min, uso único, limite por IP **e** teto global por código), relay de sinalização e serve o **viewer** (HTML + WebRTC) que abre num `BrowserView` como qualquer serviço (hibernação, workspaces, atalhos… de graça). O pareamento vira um serviço "Celular Android" na sidebar; remover o serviço revoga o token.
- **Defesas do servidor local**: o viewer só é servido para loopback com `Host` de loopback (anti DNS-rebinding), e o WebSocket do viewer exige `Origin` exato **e** uma chave aleatória por execução embutida na página — sem isso, qualquer site aberto no navegador do usuário poderia abrir `ws://127.0.0.1` e espiar/controlar o celular. Tokens ficam só como hash SHA-256 em `phones.json`.
- Validado ponta a ponta no Electron real com um "celular" simulado falando o protocolo: vídeo WebRTC renderizado no viewer e `tap`/`swipe`/`key`/`text` chegando pelo DataChannel.
- App Android em `android/` (Kotlin, Gradle). O CI (`build-android.yml`) compila o APK de debug.
- **Limitação conhecida**: sinalização `ws://` sem TLS na LAN (token pode ser lido por quem estiver capturando tráfego na mesma rede). Evolução planejada: `wss://` com certificado autoassinado e fingerprint no QR.

### Revisão (problemas reais encontrados e corrigidos antes do commit)
1. **DoS remoto sem autenticação**: `new URL('//', …)` lançava exceção no handler de `upgrade` do servidor (escuta em `0.0.0.0`); qualquer pessoa na LAN derrubava o processo principal com um `GET //` + `Upgrade`. Agora nada vindo da rede passa por `new URL`/`decodeURIComponent` sem proteção, os handlers têm try/catch e há teste que manda alvos malformados.
2. **Carimbo do sync com relógio atrasado/hostil** perdia edições locais ou travava o sync com `updatedAt` no futuro → carimbo monotônico + recusa de datas > 1 dia à frente.
3. **Celular pareado sumia ao importar/sincronizar** config com workspaces diferentes (sem UI pra revogar o token) → é movido pro primeiro workspace.
4. **Um serviço com URL inválida quebrava o sync de todos os dispositivos** (o parse recusa o arquivo inteiro) → `addService` só aceita `http(s)` e serviços inválidos nunca entram no payload.
5. **Brute-force do código de pareamento por vários IPs** → teto global de tentativas por código; mapa de falhas é podado.
6. **Viewer**: status "instável" nunca saía da tela; swipe que terminava fora do quadro virava swipe de comprimento zero; `bye` do celular deixava a última imagem congelada.
7. **`setState` serializava a config inteira (com até 200 KB de CSS/JS por serviço) duas vezes a cada atualização de unread** → comparação campo a campo (`syncableEqual`), O(1) para strings inalteradas.
8. **Condição de corrida no `SyncManager`** (achada pelos próprios testes): `syncNow()` chamado entre a decisão de sair do laço e o `.finally()` perdia a atualização. `syncNow()` agora aguarda de fato a execução em andamento.
9. **Bônus de tamanho**: `react`/`react-dom` estavam indo dentro do `app.asar` mesmo já embutidos pelo Vite no renderer → movidos para `devDependencies` (**asar 7,2 MB → 2,4 MB**, já contando `electron-updater` e `ws`).

## v2 — Controle de celular (Android) dentro do Deskbox (implementado na Leva 3)

Ideia: embutir uma tela do celular como se fosse mais um "serviço" do Deskbox, com controle de toque/teclado real, não só espelhamento passivo.

**Decisão de arquitetura (discutida, não implementada)**: modelo "estilo Chrome Remote Desktop invertido" — em vez do Deskbox puxar a tela do celular via ADB/USB (como o `scrcpy` faz), um **app companion Android** (produto novo e separado do Deskbox) roda no celular e *empurra* a própria tela pra fora:
- Captura de tela via `MediaProjection` (API oficial, consentimento único, sem root).
- Injeção de toque/gestos via `AccessibilityService` (API oficial — é como TeamViewer/AnyDesk fazem controle sem root no Android).
- Transporte via **WebRTC**; o Deskbox vira um cliente simples (`<video>` nativo do Chromium, sem decodificar H.264 na mão).

**Por que essa direção em vez de ADB/scrcpy puro**: sem cabo USB, sem precisar ativar "Opções do desenvolvedor" no celular (trava a maioria dos usuários leigos) — mais perto de uma experiência de produto real.

**Custo adicional de escopo** (motivo de ficar pra v2, não nessa fase):
- Um app Android de verdade pra manter (código, ficha na Play Store, assinatura de APK, revisão do Google) — não é "mais uma feature do Deskbox", é um segundo produto.
- Pra funcionar fora da rede local (de qualquer lugar, tipo CRD de verdade): precisa de servidor de sinalização/relay próprio (infraestrutura que o projeto não tem hoje). Alternativa mais simples pra v2 inicial: só rede local, pareamento por QR code (sem precisar de servidor).
- `AccessibilityService` passa por telas de consentimento mais rígidas no Android/Play Store (a API é comumente abusada por malware; precisa de fluxo de consentimento claro e bem explicado).
- **iOS**: controle completo não é realista pra usuário comum (Apple só permite via MDM corporativo/dispositivo supervisionado). Espelhamento (só visualização, sem controle) seria possível via QuickTime, mas só no macOS.

**Decisão em aberto pra quando essa v2 entrar em pauta**: só rede local (mais simples, sem servidor) vs. acesso de qualquer lugar (precisa de relay).
