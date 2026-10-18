import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { IPC } from '@shared/ipc'
import type { AddServicePayload } from '@shared/types'
import { Store } from './store'
import { ServicesManager } from './services-manager'

let mainWindow: BrowserWindow | null = null
// Um só Store/ServicesManager para a vida inteira do app: no macOS, fechar todas
// as janelas não encerra o processo (ver window-all-closed abaixo), e reabrir pelo
// dock ('activate') só cria uma nova BrowserWindow — o manager é reconectado a ela
// via rebindWindow() em vez de ser recriado (ver ServicesManager.rebindWindow).
let manager: ServicesManager | null = null
const store = new Store()

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

  mainWindow.on('ready-to-show', () => mainWindow?.show())

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
}

app.whenReady().then(() => {
  if (process.platform === 'darwin' && appIcon) {
    app.dock?.setIcon(appIcon)
  }

  // Registrado uma única vez: os handlers leem `manager` em tempo de chamada (não de
  // definição), então continuam válidos mesmo depois de um rebindWindow().
  registerIpcHandlers()
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
