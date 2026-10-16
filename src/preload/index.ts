import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type { AddServicePayload, DeskboxState, Theme } from '@shared/types'

const api = {
  getState: (): Promise<DeskboxState> => ipcRenderer.invoke(IPC.GET_STATE),
  getCatalog: () => ipcRenderer.invoke(IPC.GET_CATALOG),
  addService: (payload: AddServicePayload): Promise<DeskboxState> => ipcRenderer.invoke(IPC.ADD_SERVICE, payload),
  removeService: (instanceId: string): Promise<DeskboxState> => ipcRenderer.invoke(IPC.REMOVE_SERVICE, instanceId),
  reorderServices: (order: string[]): Promise<DeskboxState> => ipcRenderer.invoke(IPC.REORDER_SERVICES, order),
  selectService: (instanceId: string): Promise<DeskboxState> => ipcRenderer.invoke(IPC.SELECT_SERVICE, instanceId),
  setTheme: (theme: Theme): Promise<DeskboxState> => ipcRenderer.invoke(IPC.SET_THEME, theme),
  addWorkspace: (name: string): Promise<DeskboxState> => ipcRenderer.invoke(IPC.ADD_WORKSPACE, name),
  removeWorkspace: (workspaceId: string): Promise<DeskboxState> =>
    ipcRenderer.invoke(IPC.REMOVE_WORKSPACE, workspaceId),
  selectWorkspace: (workspaceId: string): Promise<DeskboxState> =>
    ipcRenderer.invoke(IPC.SELECT_WORKSPACE, workspaceId),
  onStateChanged: (callback: (state: DeskboxState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: DeskboxState): void => callback(state)
    ipcRenderer.on(IPC.STATE_CHANGED, listener)
    return () => ipcRenderer.removeListener(IPC.STATE_CHANGED, listener)
  }
}

export type DeskboxApi = typeof api

contextBridge.exposeInMainWorld('deskbox', api)
