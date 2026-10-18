import { randomUUID } from 'crypto'
import { BrowserView, BrowserWindow, ipcMain, session, app } from 'electron'
import { join } from 'path'
import type { AddServicePayload, DeskboxState, ServiceInstance } from '@shared/types'
import { IPC } from '@shared/ipc'
import { CATALOG, findCatalogEntry } from './catalog'

const SIDEBAR_WIDTH = 72
const HIBERNATE_AFTER_MS = 10 * 60 * 1000
const HIBERNATION_SWEEP_INTERVAL_MS = 60 * 1000

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
  private lastActiveAt = new Map<string, number>()
  private currentlyShownInstanceId: string | null = null
  /** true enquanto um modal do renderer (overlay React) precisa ficar visível. */
  private overlayOpen = false

  constructor(
    window: BrowserWindow,
    getState: () => DeskboxState,
    setState: (updater: (state: DeskboxState) => DeskboxState) => DeskboxState
  ) {
    this.window = window
    this.getState = getState
    this.setState = setState
  }

  /** Configuração única, válida para a vida inteira do app (um só Store/ServicesManager). */
  init(): void {
    const state = this.getState()
    const activeExists = state.services.some((s) => s.instanceId === state.activeInstanceId)
    if (state.activeInstanceId && activeExists) {
      this.showInstance(state.activeInstanceId)
    } else {
      const firstInWorkspace = this.servicesInWorkspace(state.activeWorkspaceId)[0]
      if (firstInWorkspace) {
        this.setState((s) => ({ ...s, activeInstanceId: firstInWorkspace.instanceId }))
        this.showInstance(firstInWorkspace.instanceId)
      }
    }

    this.attachWindowListeners()
    setInterval(() => this.sweepHibernation(), HIBERNATION_SWEEP_INTERVAL_MS)
    ipcMain.on(IPC.SERVICE_UNREAD, this.handleUnreadMessage)
  }

  /**
   * Reconecta o manager a uma nova BrowserWindow sem recriar Store/listeners/timers.
   * Necessário no macOS: fechar todas as janelas não encerra o app (window-all-closed
   * não chama app.quit() no darwin) e clicar no ícone do dock cria uma nova janela
   * (evento 'activate'); sem isso o app tentaria registrar ipcMain.handle duas vezes
   * para o mesmo canal, o que lança erro, e vazaria o setInterval de hibernação antigo
   * apontando para uma janela já destruída.
   */
  rebindWindow(window: BrowserWindow): void {
    this.window = window
    this.attachWindowListeners()
    if (!this.overlayOpen && this.currentlyShownInstanceId) {
      const view = this.views.get(this.currentlyShownInstanceId)
      if (view) {
        this.window.setBrowserView(view)
      }
    }
    this.layout()
    this.broadcastState()
  }

  /**
   * Um BrowserView sempre renderiza por cima do DOM da janela, não importa o
   * z-index do CSS — é uma camada nativa separada, não parte do stacking
   * context da página. Por isso, qualquer overlay do renderer (modal de
   * adicionar serviço, novo workspace) fica invisível atrás do serviço ativo
   * a menos que o BrowserView seja desanexado enquanto o overlay está aberto.
   */
  setOverlayOpen(open: boolean): void {
    this.overlayOpen = open
    if (open) {
      this.window.setBrowserView(null)
      return
    }
    if (this.currentlyShownInstanceId) {
      const view = this.views.get(this.currentlyShownInstanceId)
      if (view) {
        this.window.setBrowserView(view)
        this.layout()
      }
    }
  }

  private attachWindowListeners(): void {
    this.window.on('resize', () => this.layout())
    this.registerShortcuts(this.window.webContents)
  }

  /**
   * Atalhos globais de troca de serviço (Ctrl/Cmd+1..9, Ctrl/Cmd+Tab). Como cada
   * serviço roda num BrowserView com seu próprio foco de teclado, ouvir keydown
   * no React (sidebar) só funcionaria quando a sidebar estivesse focada — por
   * isso interceptamos em cada WebContents (janela principal + cada BrowserView)
   * via before-input-event, que o Electron dispara antes da página ver a tecla.
   */
  private registerShortcuts(webContents: Electron.WebContents): void {
    webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const mod = input.control || input.meta
      if (!mod) return
      if (input.key >= '1' && input.key <= '9') {
        event.preventDefault()
        this.selectServiceByIndex(Number(input.key) - 1)
      } else if (input.key === 'Tab') {
        event.preventDefault()
        this.cycleService(input.shift ? -1 : 1)
      } else if (input.key.toLowerCase() === 'k') {
        event.preventDefault()
        this.window.webContents.send(IPC.OPEN_COMMAND_PALETTE)
      }
    })
  }

  private selectServiceByIndex(index: number): void {
    const services = this.servicesInWorkspace(this.getState().activeWorkspaceId)
    const target = services[index]
    if (target) this.selectService(target.instanceId)
  }

  private cycleService(delta: number): void {
    const services = this.servicesInWorkspace(this.getState().activeWorkspaceId)
    if (services.length === 0) return
    const currentIndex = services.findIndex((s) => s.instanceId === this.getState().activeInstanceId)
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + delta + services.length) % services.length
    this.selectService(services[nextIndex].instanceId)
  }

  private handleUnreadMessage = (event: Electron.IpcMainEvent, count: number): void => {
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
  }

  getCatalog() {
    return CATALOG
  }

  /**
   * Uso de memória (RAM, em MB) por serviço ativo, pra evidenciar o ganho real
   * da hibernação. Cada BrowserView roda no seu próprio processo de renderer
   * (partições diferentes forçam isolamento de processo no Chromium), então
   * cruzamos o PID de cada webContents com app.getAppMetrics() pra achar o
   * working set dele. Serviços hibernados não têm processo, então não entram
   * no resultado (tratados como 0 no lado do renderer).
   */
  getMemoryUsage(): Record<string, number> {
    const metrics = app.getAppMetrics()
    const memoryByPid = new Map(metrics.map((metric) => [metric.pid, metric.memory.workingSetSize]))
    const result: Record<string, number> = {}
    for (const [instanceId, view] of this.views) {
      const pid = view.webContents.getOSProcessId()
      const workingSetKb = memoryByPid.get(pid)
      if (workingSetKb !== undefined) {
        result[instanceId] = Math.round(workingSetKb / 1024)
      }
    }
    return result
  }

  /** Estado enriquecido com campos calculados em tempo de execução (ex.: hibernated). */
  getEnrichedState(): DeskboxState {
    const state = this.getState()
    return {
      ...state,
      services: state.services.map((service) => ({
        ...service,
        hibernated: !this.views.has(service.instanceId)
      }))
    }
  }

  addService(payload: AddServicePayload): DeskboxState {
    const catalogEntry = payload.catalogId ? findCatalogEntry(payload.catalogId) : undefined
    const name = catalogEntry?.name ?? payload.name ?? 'Site personalizado'
    const url = catalogEntry?.url ?? payload.url
    if (!url) {
      return this.getEnrichedState()
    }
    const workspaceId = this.getState().activeWorkspaceId
    const instanceId = randomUUID()
    const instance: ServiceInstance = {
      instanceId,
      catalogId: catalogEntry?.id ?? 'custom',
      name,
      url,
      domain: catalogEntry?.domain ?? domainFromUrl(url),
      partition: `persist:deskbox-${instanceId}`,
      workspaceId,
      order: this.servicesInWorkspace(workspaceId).length,
      muted: false,
      unreadCount: 0,
      hibernated: false
    }
    this.setState((s) => ({
      ...s,
      services: [...s.services, instance],
      activeInstanceId: instanceId
    }))
    this.showInstance(instanceId)
    this.broadcastState()
    return this.getEnrichedState()
  }

  removeService(instanceId: string): DeskboxState {
    this.destroyView(instanceId)
    const state = this.setState((s) => {
      const removed = s.services.find((service) => service.instanceId === instanceId)
      const services = s.services.filter((service) => service.instanceId !== instanceId)
      let activeInstanceId = s.activeInstanceId
      if (s.activeInstanceId === instanceId) {
        const workspaceId = removed?.workspaceId ?? s.activeWorkspaceId
        const sibling = services
          .filter((service) => service.workspaceId === workspaceId)
          .sort((a, b) => a.order - b.order)[0]
        activeInstanceId = sibling?.instanceId ?? null
      }
      return { ...s, services, activeInstanceId }
    })
    if (state.activeInstanceId) {
      this.showInstance(state.activeInstanceId)
    } else {
      this.hideActiveView()
    }
    this.updateBadge()
    this.broadcastState()
    return this.getEnrichedState()
  }

  reorderServices(order: string[]): DeskboxState {
    this.setState((s) => ({
      ...s,
      services: s.services.map((service) =>
        order.includes(service.instanceId)
          ? { ...service, order: order.indexOf(service.instanceId) }
          : service
      )
    }))
    this.broadcastState()
    return this.getEnrichedState()
  }

  /**
   * Também troca activeWorkspaceId quando o serviço pertence a outro workspace
   * (ex.: salto direto pelo command palette) — sem isso, a sidebar continuaria
   * filtrando pelo workspace antigo e o serviço ativo nem apareceria nela.
   */
  selectService(instanceId: string): DeskboxState {
    const service = this.getState().services.find((s) => s.instanceId === instanceId)
    if (!service) return this.getEnrichedState()
    this.setState((s) => ({ ...s, activeInstanceId: instanceId, activeWorkspaceId: service.workspaceId }))
    this.showInstance(instanceId)
    this.broadcastState()
    return this.getEnrichedState()
  }

  setTheme(theme: DeskboxState['theme']): DeskboxState {
    this.setState((s) => ({ ...s, theme }))
    this.broadcastState()
    return this.getEnrichedState()
  }

  addWorkspace(name: string): DeskboxState {
    const id = randomUUID()
    this.setState((s) => ({ ...s, workspaces: [...s.workspaces, { id, name: name.trim() || 'Workspace' }] }))
    this.selectWorkspace(id)
    return this.getEnrichedState()
  }

  removeWorkspace(workspaceId: string): DeskboxState {
    const current = this.getState()
    if (current.workspaces.length <= 1) {
      // Nunca remove o último workspace restante.
      return this.getEnrichedState()
    }
    for (const service of current.services.filter((s) => s.workspaceId === workspaceId)) {
      this.destroyView(service.instanceId)
    }
    const state = this.setState((s) => {
      const workspaces = s.workspaces.filter((w) => w.id !== workspaceId)
      const services = s.services.filter((service) => service.workspaceId !== workspaceId)
      const wasActiveWorkspace = s.activeWorkspaceId === workspaceId
      const activeWorkspaceId = wasActiveWorkspace ? workspaces[0].id : s.activeWorkspaceId
      const activeInstanceId = wasActiveWorkspace
        ? (services.filter((svc) => svc.workspaceId === activeWorkspaceId).sort((a, b) => a.order - b.order)[0]
            ?.instanceId ?? null)
        : s.activeInstanceId
      return { ...s, workspaces, services, activeWorkspaceId, activeInstanceId }
    })
    if (state.activeInstanceId) {
      this.showInstance(state.activeInstanceId)
    } else {
      this.hideActiveView()
    }
    this.updateBadge()
    this.broadcastState()
    return this.getEnrichedState()
  }

  selectWorkspace(workspaceId: string): DeskboxState {
    const state = this.setState((s) => {
      const firstService = this.servicesInWorkspace(workspaceId, s)[0]
      return { ...s, activeWorkspaceId: workspaceId, activeInstanceId: firstService?.instanceId ?? null }
    })
    if (state.activeInstanceId) {
      this.showInstance(state.activeInstanceId)
    } else {
      this.hideActiveView()
    }
    this.broadcastState()
    return this.getEnrichedState()
  }

  private servicesInWorkspace(workspaceId: string, state: DeskboxState = this.getState()): ServiceInstance[] {
    return state.services.filter((service) => service.workspaceId === workspaceId).sort((a, b) => a.order - b.order)
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
    this.registerShortcuts(view.webContents)
    this.views.set(instance.instanceId, view)
    this.webContentsIdToInstance.set(view.webContents.id, instance.instanceId)
  }

  /** Mostra uma instância, recriando o BrowserView sob demanda se ela estiver hibernada. */
  private showInstance(instanceId: string): void {
    if (this.currentlyShownInstanceId && this.currentlyShownInstanceId !== instanceId) {
      this.lastActiveAt.set(this.currentlyShownInstanceId, Date.now())
    }
    let view = this.views.get(instanceId)
    if (!view) {
      const service = this.getState().services.find((s) => s.instanceId === instanceId)
      if (!service) return
      this.createViewForInstance(service)
      view = this.views.get(instanceId)
    }
    if (!view) return
    this.lastActiveAt.set(instanceId, Date.now())
    this.currentlyShownInstanceId = instanceId
    if (!this.overlayOpen) {
      this.window.setBrowserView(view)
      this.layout()
    }
  }

  private hideActiveView(): void {
    if (this.currentlyShownInstanceId) {
      this.lastActiveAt.set(this.currentlyShownInstanceId, Date.now())
    }
    this.currentlyShownInstanceId = null
    this.window.setBrowserView(null)
  }

  /** Descarrega o BrowserView da memória. A sessão (persist:) continua salva em disco. */
  private destroyView(instanceId: string): void {
    const view = this.views.get(instanceId)
    if (!view) return
    if (this.currentlyShownInstanceId === instanceId) {
      this.window.setBrowserView(null)
      this.currentlyShownInstanceId = null
    }
    try {
      view.webContents.close()
    } catch {
      // versões diferentes do Electron podem não expor close(); seguimos sem travar
    }
    this.webContentsIdToInstance.delete(view.webContents.id)
    this.views.delete(instanceId)
    this.lastActiveAt.delete(instanceId)
  }

  private sweepHibernation(): void {
    const now = Date.now()
    let changed = false
    for (const instanceId of [...this.views.keys()]) {
      if (instanceId === this.currentlyShownInstanceId) continue
      const lastActive = this.lastActiveAt.get(instanceId) ?? now
      if (now - lastActive >= HIBERNATE_AFTER_MS) {
        this.destroyView(instanceId)
        changed = true
      }
    }
    if (changed) this.broadcastState()
  }

  private layout(): void {
    if (!this.currentlyShownInstanceId) return
    const view = this.views.get(this.currentlyShownInstanceId)
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
    this.window.webContents.send(IPC.STATE_CHANGED, this.getEnrichedState())
  }
}
