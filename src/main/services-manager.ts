import { randomUUID } from 'crypto'
import { BrowserView, BrowserWindow, ipcMain, session, app } from 'electron'
import { join } from 'path'
import type { AddServicePayload, DeskboxState, ServiceInstance } from '@shared/types'
import { IPC } from '@shared/ipc'
import { CATALOG, findCatalogEntry } from './catalog'

const SIDEBAR_WIDTH = 72

function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

export class ServicesManager {
  private window: BrowserWindow
  private getState: () => DeskboxState
  private setState: (updater: (state: DeskboxState) => DeskboxState) => DeskboxState
  private views = new Map<string, BrowserView>()
  private webContentsIdToInstance = new Map<number, string>()

  constructor(
    window: BrowserWindow,
    getState: () => DeskboxState,
    setState: (updater: (state: DeskboxState) => DeskboxState) => DeskboxState
  ) {
    this.window = window
    this.getState = getState
    this.setState = setState
  }

  init(): void {
    for (const service of this.getState().services) {
      this.createViewForInstance(service)
    }
    const active = this.getState().activeInstanceId
    if (active && this.views.has(active)) {
      this.showInstance(active)
    } else if (this.getState().services.length > 0) {
      this.showInstance(this.getState().services[0].instanceId)
    }

    this.window.on('resize', () => this.layout())
    ipcMain.on(IPC.SERVICE_UNREAD, (event, count: number) => {
      const instanceId = this.webContentsIdToInstance.get(event.sender.id)
      if (!instanceId) return
      this.setState((state) => ({
        ...state,
        services: state.services.map((service) =>
          service.instanceId === instanceId ? { ...service, unreadCount: count } : service
        )
      }))
      this.updateBadge()
      this.broadcastState()
    })
  }

  getCatalog() {
    return CATALOG
  }

  addService(payload: AddServicePayload): DeskboxState {
    const catalogEntry = payload.catalogId ? findCatalogEntry(payload.catalogId) : undefined
    const name = catalogEntry?.name ?? payload.name ?? 'Site personalizado'
    const url = catalogEntry?.url ?? payload.url
    if (!url) {
      return this.getState()
    }
    const instanceId = randomUUID()
    const instance: ServiceInstance = {
      instanceId,
      catalogId: catalogEntry?.id ?? 'custom',
      name,
      url,
      domain: catalogEntry?.domain ?? domainFromUrl(url),
      partition: `persist:deskbox-${instanceId}`,
      order: this.getState().services.length,
      muted: false,
      unreadCount: 0
    }
    const state = this.setState((s) => ({
      ...s,
      services: [...s.services, instance],
      activeInstanceId: instanceId
    }))
    this.createViewForInstance(instance)
    this.showInstance(instanceId)
    this.broadcastState()
    return state
  }

  removeService(instanceId: string): DeskboxState {
    const view = this.views.get(instanceId)
    if (view) {
      this.window.removeBrowserView(view)
      try {
        view.webContents.close()
      } catch {
        // versões diferentes do Electron podem não expor close(); seguimos sem travar
      }
      this.webContentsIdToInstance.delete(view.webContents.id)
      this.views.delete(instanceId)
    }
    const state = this.setState((s) => {
      const services = s.services.filter((service) => service.instanceId !== instanceId)
      const activeInstanceId = s.activeInstanceId === instanceId ? (services[0]?.instanceId ?? null) : s.activeInstanceId
      return { ...s, services, activeInstanceId }
    })
    if (state.activeInstanceId) {
      this.showInstance(state.activeInstanceId)
    }
    this.updateBadge()
    this.broadcastState()
    return state
  }

  reorderServices(order: string[]): DeskboxState {
    const state = this.setState((s) => ({
      ...s,
      services: s.services
        .map((service) => ({ ...service, order: order.indexOf(service.instanceId) }))
        .sort((a, b) => a.order - b.order)
    }))
    this.broadcastState()
    return state
  }

  selectService(instanceId: string): DeskboxState {
    const state = this.setState((s) => ({ ...s, activeInstanceId: instanceId }))
    this.showInstance(instanceId)
    this.broadcastState()
    return state
  }

  setTheme(theme: DeskboxState['theme']): DeskboxState {
    const state = this.setState((s) => ({ ...s, theme }))
    this.broadcastState()
    return state
  }

  private createViewForInstance(instance: ServiceInstance): void {
    const partitionSession = session.fromPartition(instance.partition)
    partitionSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(permission === 'notifications' || permission === 'media')
    })

    const view = new BrowserView({
      webPreferences: {
        partition: instance.partition,
        preload: join(__dirname, '../preload/service.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })
    view.webContents.loadURL(instance.url)
    this.views.set(instance.instanceId, view)
    this.webContentsIdToInstance.set(view.webContents.id, instance.instanceId)
  }

  private showInstance(instanceId: string): void {
    const view = this.views.get(instanceId)
    if (!view) return
    this.window.setBrowserView(view)
    this.layout()
  }

  private layout(): void {
    const activeId = this.getState().activeInstanceId
    if (!activeId) return
    const view = this.views.get(activeId)
    if (!view) return
    const bounds = this.window.getContentBounds()
    view.setBounds({
      x: SIDEBAR_WIDTH,
      y: 0,
      width: Math.max(0, bounds.width - SIDEBAR_WIDTH),
      height: bounds.height
    })
  }

  private updateBadge(): void {
    const total = this.getState().services.reduce((sum, service) => sum + service.unreadCount, 0)
    try {
      app.setBadgeCount(total)
    } catch {
      // nem toda plataforma suporta badge (ex.: Windows); seguimos sem travar
    }
  }

  private broadcastState(): void {
    this.window.webContents.send(IPC.STATE_CHANGED, this.getState())
  }
}
