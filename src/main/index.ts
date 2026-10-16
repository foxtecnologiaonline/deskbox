import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { IPC } from '@shared/ipc'
import type { AddServicePayload } from '@shared/types'
import { Store } from './store'
import { ServicesManager } from './services-manager'

let mainWindow: BrowserWindow | null = null

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 760,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
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

  ipcMain.handle(IPC.GET_STATE, () => store.getState())
  ipcMain.handle(IPC.GET_CATALOG, () => manager.getCatalog())
  ipcMain.handle(IPC.ADD_SERVICE, (_event, payload: AddServicePayload) => manager.addService(payload))
  ipcMain.handle(IPC.REMOVE_SERVICE, (_event, instanceId: string) => manager.removeService(instanceId))
  ipcMain.handle(IPC.REORDER_SERVICES, (_event, order: string[]) => manager.reorderServices(order))
  ipcMain.handle(IPC.SELECT_SERVICE, (_event, instanceId: string) => manager.selectService(instanceId))
  ipcMain.handle(IPC.SET_THEME, (_event, theme: 'light' | 'dark' | 'system') => manager.setTheme(theme))

  manager.init()

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
