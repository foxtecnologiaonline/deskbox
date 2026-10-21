import { app, BrowserWindow, dialog, ipcMain, shell, Tray, Menu } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { IPC } from '@shared/ipc'
import type {
  AddServicePayload,
  ExportedConfig,
  ImportConfigResult,
  ProxyConfig,
  SetPasswordPayload,
  SidebarDensity
} from '@shared/types'
import { Store } from './store'
import { ServicesManager } from './services-manager'

// Build portátil (electron-builder "portable" no Windows): ao rodar o .exe
// direto de um pendrive/pasta, sem instalar, o electron-builder expõe a pasta
// onde ele está em PORTABLE_EXECUTABLE_DIR. Redirecionamos userData pra lá
// (em vez de %APPDATA%) pra que configuração e sessões dos serviços viajem
// junto com o executável — nada fica gravado no computador usado, e o mesmo
// pendrive mantém os logins ao trocar de máquina. Precisa rodar antes de
// qualquer leitura de app.getPath('userData') — por isso logo no topo,
// antes até da instância de Store.
const portableDir = process.env['PORTABLE_EXECUTABLE_DIR']
if (portableDir) {
  app.setPath('userData', join(portableDir, 'DeskboxData'))
}

let mainWindow: BrowserWindow | null = null
// Um só Store/ServicesManager para a vida inteira do app: no macOS, fechar todas
// as janelas não encerra o processo (ver window-all-closed abaixo), e reabrir pelo
// dock ('activate') só cria uma nova BrowserWindow — o manager é reconectado a ela
// via rebindWindow() em vez de ser recriado (ver ServicesManager.rebindWindow).
let manager: ServicesManager | null = null
const store = new Store()
let tray: Tray | null = null
// true só entre o clique em "Sair" do tray e o app.quit() de fato — sem essa
// flag, o handler de 'close' (que vira minimizar pra bandeja) interceptaria
// até o fechamento disparado pelo próprio menu de saída.
let isQuitting = false

/** Cria o ícone da bandeja só se algum recurso que depende dele estiver ativo. */
function syncTray(): void {
  const state = store.getState()
  const needed = state.minimizeToTray || state.startMinimized
  if (needed && !tray && appIcon) {
    tray = new Tray(appIcon)
    tray.setToolTip('Deskbox')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Abrir Deskbox', click: () => showMainWindow() },
        { type: 'separator' },
        {
          label: 'Sair',
          click: () => {
            isQuitting = true
            app.quit()
          }
        }
      ])
    )
    tray.on('click', () => showMainWindow())
  } else if (!needed && tray) {
    tray.destroy()
    tray = null
  }
}

// true só entre um clique explícito em "Abrir Deskbox"/no ícone do tray e o
// próximo 'ready-to-show' — garante que esse pedido explícito sempre mostra a
// janela, mesmo com "iniciar minimizado" ativo (que só deve valer pro boot do
// app, não pra reabrir de propósito depois de fechada de verdade).
let forceShowOnReady = false

function showMainWindow(): void {
  if (!mainWindow) {
    forceShowOnReady = true
    createMainWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

// Resolve o ícone customizado em qualquer contexto de execução:
// - app empacotado / `npm run build` + preview: out/renderer/favicon.png está
//   dentro de `files: ["out/**/*"]` do electron-builder, então existe dentro do
//   app.asar em runtime (build/icon.png NÃO é empacotado — é usado só para gerar
//   os ícones da plataforma durante `electron-builder`, nunca copiado para out/).
// - `npm run dev`: o renderer é servido pelo Vite dev server (nada em out/renderer/
//   ainda), então cai para o arquivo-fonte em build/icon.png na raiz do projeto.
function resolveAppIcon(): string | undefined {
  const candidates = [join(__dirname, '../renderer/favicon.png'), join(__dirname, '../../build/icon.png')]
  return candidates.find((candidate) => existsSync(candidate))
}

const appIcon = resolveAppIcon()

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 760,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    icon: appIcon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // Sem isso, `mainWindow` continuaria apontando pra um BrowserWindow já destruído
  // depois de um close "de verdade" (minimizeToTray desligado) — showMainWindow()
  // leria esse ponteiro obsoleto e chamaria métodos num objeto destruído.
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.on('ready-to-show', () => {
    // !tray cobre o caso (defensivo) de appIcon não ter sido resolvido: sem
    // tray pra reabrir, "iniciar minimizado" deixaria o app inteiramente
    // inacessível — melhor mostrar a janela do que travar o usuário sem saída.
    if (forceShowOnReady || !store.getState().startMinimized || !tray) {
      forceShowOnReady = false
      mainWindow?.show()
    }
  })

  // Fechar a janela (botão "x") minimiza pra bandeja em vez de encerrar o app,
  // quando habilitado — a sessão dos serviços continua rodando em memória.
  // isQuitting é setado só pelo "Sair" do menu do tray, que precisa fechar de
  // verdade. && tray evita a mesma armadilha: sem ícone na bandeja pra reabrir,
  // minimizar pra "lugar nenhum" deixaria o app inacessível sem matar o processo.
  mainWindow.on('close', (event) => {
    if (!isQuitting && store.getState().minimizeToTray && tray) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (manager) {
    manager.rebindWindow(mainWindow)
  } else {
    manager = new ServicesManager(
      mainWindow,
      () => store.getState(),
      (updater) => store.setState(updater)
    )
    manager.init()
  }

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC.GET_STATE, () => manager!.getEnrichedState())
  ipcMain.handle(IPC.GET_CATALOG, () => manager!.getCatalog())
  ipcMain.handle(IPC.ADD_SERVICE, (_event, payload: AddServicePayload) => manager!.addService(payload))
  ipcMain.handle(IPC.REMOVE_SERVICE, (_event, instanceId: string) => manager!.removeService(instanceId))
  ipcMain.handle(IPC.REORDER_SERVICES, (_event, order: string[]) => manager!.reorderServices(order))
  ipcMain.handle(IPC.SELECT_SERVICE, (_event, instanceId: string) => manager!.selectService(instanceId))
  ipcMain.handle(IPC.SET_THEME, (_event, theme: 'light' | 'dark' | 'system') => manager!.setTheme(theme))
  ipcMain.handle(IPC.ADD_WORKSPACE, (_event, name: string) => manager!.addWorkspace(name))
  ipcMain.handle(IPC.REMOVE_WORKSPACE, (_event, workspaceId: string) => manager!.removeWorkspace(workspaceId))
  ipcMain.handle(IPC.SELECT_WORKSPACE, (_event, workspaceId: string) => manager!.selectWorkspace(workspaceId))
  ipcMain.handle(IPC.SET_OVERLAY_OPEN, (_event, open: boolean) => manager!.setOverlayOpen(open))
  ipcMain.handle(IPC.GET_MEMORY_USAGE, () => manager!.getMemoryUsage())
  ipcMain.handle(IPC.UNLOCK, (_event, password: string) => manager!.unlock(password))
  ipcMain.handle(IPC.LOCK_NOW, () => manager!.lockNow())
  ipcMain.handle(IPC.SET_PASSWORD, (_event, payload: SetPasswordPayload) =>
    manager!.setPassword(payload.newPassword, payload.currentPassword)
  )
  ipcMain.handle(IPC.SET_PROXY, (_event, config: ProxyConfig | null) => manager!.setProxy(config))
  ipcMain.handle(IPC.SET_HIBERNATE_MINUTES, (_event, minutes: number | null) =>
    manager!.setHibernateAfterMinutes(minutes)
  )
  ipcMain.handle(IPC.DISMISS_ONBOARDING, () => manager!.dismissOnboarding())
  ipcMain.handle(IPC.MOVE_SERVICE_TO_WORKSPACE, (_event, instanceId: string, workspaceId: string) =>
    manager!.moveServiceToWorkspace(instanceId, workspaceId)
  )
  ipcMain.handle(IPC.EXPORT_CONFIG, async () => {
    if (manager!.getEnrichedState().locked) {
      return { ok: false, error: 'Destrave o app antes de exportar.' }
    }
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: 'Exportar configuração do Deskbox',
      defaultPath: 'deskbox-config.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return { ok: false, error: 'Cancelado.' }
    try {
      const data: ExportedConfig = manager!.exportConfig()
      writeFileSync(result.filePath, JSON.stringify(data, null, 2), 'utf-8')
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Falha ao salvar o arquivo.' }
    }
  })
  ipcMain.handle(IPC.IMPORT_CONFIG, async (): Promise<ImportConfigResult> => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Importar configuração do Deskbox',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false, error: 'Cancelado.' }
    try {
      const raw = readFileSync(result.filePaths[0], 'utf-8')
      const parsed = JSON.parse(raw) as ExportedConfig
      return manager!.importConfig(parsed)
    } catch {
      return { ok: false, error: 'Arquivo inválido ou corrompido.' }
    }
  })
  ipcMain.handle(IPC.TOGGLE_SERVICE_PINNED, (_event, instanceId: string) => manager!.toggleServicePinned(instanceId))
  ipcMain.handle(IPC.SET_SIDEBAR_DENSITY, (_event, density: SidebarDensity) => manager!.setSidebarDensity(density))
  ipcMain.handle(IPC.SET_NOTIFICATIONS_ENABLED, (_event, enabled: boolean) =>
    manager!.setNotificationsEnabled(enabled)
  )
  ipcMain.handle(IPC.SET_MINIMIZE_TO_TRAY, (_event, enabled: boolean) => {
    const state = manager!.setMinimizeToTray(enabled)
    syncTray()
    return state
  })
  ipcMain.handle(IPC.SET_LAUNCH_AT_LOGIN, (_event, enabled: boolean) => {
    const state = manager!.setLaunchAtLogin(enabled)
    app.setLoginItemSettings({ openAtLogin: enabled })
    return state
  })
  ipcMain.handle(IPC.SET_START_MINIMIZED, (_event, enabled: boolean) => {
    const state = manager!.setStartMinimized(enabled)
    syncTray()
    return state
  })
}

app.whenReady().then(() => {
  if (process.platform === 'darwin' && appIcon) {
    app.dock?.setIcon(appIcon)
  }

  // Reaplica a preferência salva no SO a cada boot — cobre o caso de o registro de
  // login do SO ter sido perdido (reinstalação, perfil novo) enquanto a config salva
  // continuava com launchAtLogin: true.
  app.setLoginItemSettings({ openAtLogin: store.getState().launchAtLogin })

  // Registrado uma única vez: os handlers leem `manager` em tempo de chamada (não de
  // definição), então continuam válidos mesmo depois de um rebindWindow().
  registerIpcHandlers()
  createMainWindow()
  syncTray()

  app.on('activate', () => showMainWindow())

  // isQuitting também precisa ficar true pra qualquer saída que não passe pelo
  // "Sair" do tray (Cmd+Q no macOS, "Sair" do Dock, SIGTERM do SO etc.) — sem
  // isso, o handler de 'close' interceptava até essas saídas "de verdade" e
  // minimizava pra bandeja em vez de deixar o app encerrar, e o app.quit()
  // nunca completava (nenhuma janela chega a fechar de fato, então
  // window-all-closed nunca dispara).
  app.on('before-quit', () => {
    isQuitting = true
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
