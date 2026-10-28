import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  AddServicePayload,
  ImportConfigResult,
  PairingInfo,
  PhoneEvent,
  PhoneLinkResult,
  ProxyConfig,
  RendererState,
  ServiceSettingsPayload,
  SetPasswordResult,
  SetSyncPayload,
  SidebarDensity,
  SyncResult,
  Theme,
  UpdateStatus
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
  toggleServicePinned: (instanceId: string): Promise<RendererState> =>
    ipcRenderer.invoke(IPC.TOGGLE_SERVICE_PINNED, instanceId),
  setSidebarDensity: (density: SidebarDensity): Promise<RendererState> =>
    ipcRenderer.invoke(IPC.SET_SIDEBAR_DENSITY, density),
  setNotificationsEnabled: (enabled: boolean): Promise<RendererState> =>
    ipcRenderer.invoke(IPC.SET_NOTIFICATIONS_ENABLED, enabled),
  setMinimizeToTray: (enabled: boolean): Promise<RendererState> =>
    ipcRenderer.invoke(IPC.SET_MINIMIZE_TO_TRAY, enabled),
  setLaunchAtLogin: (enabled: boolean): Promise<RendererState> =>
    ipcRenderer.invoke(IPC.SET_LAUNCH_AT_LOGIN, enabled),
  setStartMinimized: (enabled: boolean): Promise<RendererState> =>
    ipcRenderer.invoke(IPC.SET_START_MINIMIZED, enabled),
  setServiceSettings: (payload: ServiceSettingsPayload): Promise<RendererState> =>
    ipcRenderer.invoke(IPC.SET_SERVICE_SETTINGS, payload),
  setAutoUpdate: (enabled: boolean): Promise<RendererState> => ipcRenderer.invoke(IPC.SET_AUTO_UPDATE, enabled),
  getUpdateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke(IPC.GET_UPDATE_STATUS),
  checkForUpdates: (): Promise<UpdateStatus> => ipcRenderer.invoke(IPC.CHECK_FOR_UPDATES),
  installUpdate: (): Promise<void> => ipcRenderer.invoke(IPC.INSTALL_UPDATE),
  openReleases: (): Promise<void> => ipcRenderer.invoke(IPC.OPEN_RELEASES),
  chooseSyncFolder: (): Promise<string | null> => ipcRenderer.invoke(IPC.CHOOSE_SYNC_FOLDER),
  enableSync: (
    payload: SetSyncPayload,
    resolve?: 'remote' | 'local'
  ): Promise<SyncResult & { conflict?: { updatedAt: number; services: number; workspaces: number } }> =>
    ipcRenderer.invoke(IPC.ENABLE_SYNC, payload, resolve),
  disableSync: (): Promise<void> => ipcRenderer.invoke(IPC.DISABLE_SYNC),
  syncNow: (): Promise<void> => ipcRenderer.invoke(IPC.SYNC_NOW),
  provideSyncPassphrase: (passphrase: string): Promise<SyncResult> => ipcRenderer.invoke(IPC.SYNC_PASSPHRASE, passphrase),
  startPhonePairing: (): Promise<PairingInfo> => ipcRenderer.invoke(IPC.PHONE_START_PAIRING),
  cancelPhonePairing: (): Promise<void> => ipcRenderer.invoke(IPC.PHONE_CANCEL_PAIRING),
  linkPhone: (address: string, code: string): Promise<PhoneLinkResult> => ipcRenderer.invoke(IPC.PHONE_LINK, address, code),
  onUpdateStatus: (callback: (status: UpdateStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: UpdateStatus): void => callback(status)
    ipcRenderer.on(IPC.UPDATE_STATUS, listener)
    return () => ipcRenderer.removeListener(IPC.UPDATE_STATUS, listener)
  },
  onPhoneChanged: (callback: (event: PhoneEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, phoneEvent: PhoneEvent): void => callback(phoneEvent)
    ipcRenderer.on(IPC.PHONE_CHANGED, listener)
    return () => ipcRenderer.removeListener(IPC.PHONE_CHANGED, listener)
  },
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
