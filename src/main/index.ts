import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { IPC } from '@shared/ipc'
import type { AddServicePayload } from '@shared/types'
import { Store } from './store'
import { ServicesManager } from './services-manager'

let mainWindow: BrowserWindow | null = null

// Em dev, resolve a partir de out/main/index.js até a raiz do projeto. Em um app
// empacotado o diretório build/ não é incluído nos recursos (electron-builder só o
// usa para gerar os ícones da plataforma), então o caminho simplesmente não existe
// e o ícone do sistema operacional (já embutido no pacote) é o que prevalece.
const iconPath = join(__dirname, '../../build/icon.png')
const appIcon = existsSync(iconPath) ? iconPath : undefined

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

  const store = new Store()
  const manager = new ServicesManager(
    mainWindow,
    () => store.getState(),
    (updater) => store.setState(updater)
  )

  ipcMain.handle(IPC.GET_STATE, () => manager.getEnrichedState())
  ipcMain.handle(IPC.GET_CATALOG, () => manager.getCatalog())
  ipcMain.handle(IPC.ADD_SERVICE, (_event, payload: AddServicePayload) => manager.addService(payload))
  ipcMain.handle(IPC.REMOVE_SERVICE, (_event, instanceId: string) => manager.removeService(instanceId))
  ipcMain.handle(IPC.REORDER_SERVICES, (_event, order: string[]) => manager.reorderServices(order))
  ipcMain.handle(IPC.SELECT_SERVICE, (_event, instanceId: string) => manager.selectService(instanceId))
  ipcMain.handle(IPC.SET_THEME, (_event, theme: 'light' | 'dark' | 'system') => manager.setTheme(theme))
  ipcMain.handle(IPC.ADD_WORKSPACE, (_event, name: string) => manager.addWorkspace(name))
  ipcMain.handle(IPC.REMOVE_WORKSPACE, (_event, workspaceId: string) => manager.removeWorkspace(workspaceId))
  ipcMain.handle(IPC.SELECT_WORKSPACE, (_event, workspaceId: string) => manager.selectWorkspace(workspaceId))

  manager.init()

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  if (process.platform === 'darwin' && appIcon) {
    app.dock?.setIcon(appIcon)
  }

  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
