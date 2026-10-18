import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  AddServicePayload,
  ImportConfigResult,
  ProxyConfig,
  RendererState,
  SetPasswordResult,
  Theme
} from '@shared/types'

const api = {
  getState: (): Promise<RendererState> => ipcRenderer.invoke(IPC.GET_STATE),
  getCatalog: () => ipcRenderer.invoke(IPC.GET_CATALOG),
  addService: (payload: AddServicePayload): Promise<RendererState> => ipcRenderer.invoke(IPC.ADD_SERVICE, payload),
  removeService: (instanceId: string): Promise<RendererState> => ipcRenderer.invoke(IPC.REMOVE_SERVICE, instanceId),
  reorderServices: (order: string[]): Promise<RendererState> => ipcRenderer.invoke(IPC.REORDER_SERVICES, order),
  selectService: (instanceId: string): Promise<RendererState> => ipcRenderer.invoke(IPC.SELECT_SERVICE, instanceId),
  setTheme: (theme: Theme): Promise<RendererState> => ipcRenderer.invoke(IPC.SET_THEME, theme),
  addWorkspace: (name: string): Promise<RendererState> => ipcRenderer.invoke(IPC.ADD_WORKSPACE, name),
  removeWorkspace: (workspaceId: string): Promise<RendererState> =>
    ipcRenderer.invoke(IPC.REMOVE_WORKSPACE, workspaceId),
  selectWorkspace: (workspaceId: string): Promise<RendererState> =>
    ipcRenderer.invoke(IPC.SELECT_WORKSPACE, workspaceId),
  setOverlayOpen: (open: boolean): Promise<void> => ipcRenderer.invoke(IPC.SET_OVERLAY_OPEN, open),
  getMemoryUsage: (): Promise<Record<string, number>> => ipcRenderer.invoke(IPC.GET_MEMORY_USAGE),
  unlock: (password: string): Promise<boolean> => ipcRenderer.invoke(IPC.UNLOCK, password),
  lockNow: (): Promise<void> => ipcRenderer.invoke(IPC.LOCK_NOW),
  setPassword: (newPassword: string | null, currentPassword?: string): Promise<SetPasswordResult> =>
    ipcRenderer.invoke(IPC.SET_PASSWORD, { newPassword, currentPassword }),
  setProxy: (config: ProxyConfig | null): Promise<RendererState> => ipcRenderer.invoke(IPC.SET_PROXY, config),
  setHibernateAfterMinutes: (minutes: number | null): Promise<RendererState> =>
    ipcRenderer.invoke(IPC.SET_HIBERNATE_MINUTES, minutes),
  dismissOnboarding: (): Promise<RendererState> => ipcRenderer.invoke(IPC.DISMISS_ONBOARDING),
  moveServiceToWorkspace: (instanceId: string, workspaceId: string): Promise<RendererState> =>
    ipcRenderer.invoke(IPC.MOVE_SERVICE_TO_WORKSPACE, instanceId, workspaceId),
  exportConfig: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(IPC.EXPORT_CONFIG),
  importConfig: (): Promise<ImportConfigResult> => ipcRenderer.invoke(IPC.IMPORT_CONFIG),
  onStateChanged: (callback: (state: RendererState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: RendererState): void => callback(state)
    ipcRenderer.on(IPC.STATE_CHANGED, listener)
    return () => ipcRenderer.removeListener(IPC.STATE_CHANGED, listener)
  },
  onOpenCommandPalette: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.OPEN_COMMAND_PALETTE, listener)
    return () => ipcRenderer.removeListener(IPC.OPEN_COMMAND_PALETTE, listener)
  }
}

export type DeskboxApi = typeof api

contextBridge.exposeInMainWorld('deskbox', api)
