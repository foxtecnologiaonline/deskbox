import { randomUUID } from 'crypto'
import { BrowserView, BrowserWindow, ipcMain, session, app, Notification } from 'electron'
import { join } from 'path'
import type {
  AddServicePayload,
  DeskboxState,
  ExportedConfig,
  ImportConfigResult,
  ProxyConfig,
  RendererState,
  ServiceInstance,
  SetPasswordResult,
  SidebarDensity
} from '@shared/types'
import { IPC } from '@shared/ipc'
import { CATALOG, findCatalogEntry } from './catalog'
import { hashPassword, verifyPassword } from './password'

const SIDEBAR_WIDTH_COMFORTABLE = 72
const SIDEBAR_WIDTH_COMPACT = 56
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
  /** instanceIds cujo BrowserView está no meio de um carregamento (did-start-loading..did-stop-loading). */
  private loadingInstanceIds = new Set<string>()
  /** true enquanto um modal do renderer (overlay React) precisa ficar visível. */
  private overlayOpen = false
  /** true quando o app está trancado por senha mestre — nenhum BrowserView é exibido. */
  private locked = false
  /** Coalesce múltiplas chamadas síncronas de broadcastState() num único envio de IPC. */
  private broadcastScheduled = false

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
    this.locked = state.passwordHash !== null
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
    this.reattachActiveViewIfAllowed()
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
    this.reattachActiveViewIfAllowed()
  }

  /** Reanexa o BrowserView ativo à janela, a menos que um overlay/lock esteja impedindo. */
  private reattachActiveViewIfAllowed(): void {
    if (this.overlayOpen || this.locked || !this.currentlyShownInstanceId) return
    const view = this.views.get(this.currentlyShownInstanceId)
    if (view) {
      this.window.setBrowserView(view)
      this.layout()
    }
  }

  /** true se existe uma senha mestre configurada (nunca expõe o hash). */
  hasPassword(): boolean {
    return this.getState().passwordHash !== null
  }

  /** Confere a senha e destrava o app se correta. Sem senha configurada, sempre destrava. */
  async unlock(password: string): Promise<boolean> {
    const hash = this.getState().passwordHash
    if (!hash || (await verifyPassword(password, hash))) {
      this.locked = false
      this.reattachActiveViewIfAllowed()
      this.broadcastState()
      return true
    }
    return false
  }

  /** Tranca o app na hora (sem efeito se nenhuma senha estiver configurada). */
  lockNow(): void {
    if (!this.hasPassword()) return
    this.locked = true
    this.window.setBrowserView(null)
    this.broadcastState()
  }

  /**
   * Define, troca ou remove a senha mestre. Se já existe uma senha configurada,
   * exige a senha atual correta pra trocar ou remover (evita que qualquer IPC
   * destrave/altere a proteção sem confirmar que quem está pedindo já sabe a
   * senha vigente).
   */
  async setPassword(newPassword: string | null, currentPassword?: string): Promise<SetPasswordResult> {
    if (this.locked) return { ok: false, error: 'Destrave o app antes de alterar a senha.' }
    const currentHash = this.getState().passwordHash
    if (currentHash) {
      if (!currentPassword || !(await verifyPassword(currentPassword, currentHash))) {
        return { ok: false, error: 'Senha atual incorreta.' }
      }
    }
    const nextHash = newPassword ? await hashPassword(newPassword) : null
    this.setState((s) => ({ ...s, passwordHash: nextHash }))
    this.broadcastState()
    return { ok: true }
  }

  /**
   * Proxy global (todas as sessões, inclusive novos serviços). Aplicado à sessão
   * default e a cada BrowserView já existente; `createViewForInstance` aplica o
   * mesmo proxy a sessões novas.
   */
  async setProxy(config: ProxyConfig | null): Promise<RendererState> {
    if (this.locked) return this.getEnrichedState()
    this.setState((s) => ({ ...s, proxy: config }))
    const tasks = [this.applyProxyToSession(session.defaultSession)]
    for (const view of this.views.values()) {
      tasks.push(this.applyProxyToSession(view.webContents.session))
    }
    await Promise.all(tasks)
    this.broadcastState()
    return this.getEnrichedState()
  }

  private async applyProxyToSession(target: Electron.Session): Promise<void> {
    const proxy = this.getState().proxy
    const proxyRules = proxy?.rules.trim() || ''
    await target.setProxy({ proxyRules })
  }

  /** `minutes: null` desativa a hibernação automática (serviços nunca descarregam sozinhos). */
  setHibernateAfterMinutes(minutes: number | null): RendererState {
    if (this.locked) return this.getEnrichedState()
    this.setState((s) => ({ ...s, hibernateAfterMinutes: minutes }))
    this.broadcastState()
    return this.getEnrichedState()
  }

  dismissOnboarding(): RendererState {
    if (this.locked) return this.getEnrichedState()
    this.setState((s) => ({ ...s, onboardingDismissed: true }))
    this.broadcastState()
    return this.getEnrichedState()
  }

  /** `pinned: true` faz o serviço nunca hibernar sozinho, mesmo com hibernação automática ativa. */
  toggleServicePinned(instanceId: string): RendererState {
    if (this.locked) return this.getEnrichedState()
    this.setState((s) => ({
      ...s,
      services: s.services.map((service) =>
        service.instanceId === instanceId ? { ...service, pinned: !service.pinned } : service
      )
    }))
    this.broadcastState()
    return this.getEnrichedState()
  }

  setSidebarDensity(density: SidebarDensity): RendererState {
    if (this.locked) return this.getEnrichedState()
    this.setState((s) => ({ ...s, sidebarDensity: density }))
    this.layout()
    this.broadcastState()
    return this.getEnrichedState()
  }

  setNotificationsEnabled(enabled: boolean): RendererState {
    if (this.locked) return this.getEnrichedState()
    this.setState((s) => ({ ...s, notificationsEnabled: enabled }))
    this.broadcastState()
    return this.getEnrichedState()
  }

  /** Persistência pura — o efeito colateral (criar/destruir o Tray) é feito pelo chamador em index.ts. */
  setMinimizeToTray(enabled: boolean): RendererState {
    if (this.locked) return this.getEnrichedState()
    this.setState((s) => ({ ...s, minimizeToTray: enabled }))
    this.broadcastState()
    return this.getEnrichedState()
  }

  /** Persistência pura — o efeito colateral (app.setLoginItemSettings) é feito pelo chamador em index.ts. */
  setLaunchAtLogin(enabled: boolean): RendererState {
    if (this.locked) return this.getEnrichedState()
    this.setState((s) => ({ ...s, launchAtLogin: enabled }))
    this.broadcastState()
    return this.getEnrichedState()
  }

  setStartMinimized(enabled: boolean): RendererState {
    if (this.locked) return this.getEnrichedState()
    this.setState((s) => ({ ...s, startMinimized: enabled }))
    this.broadcastState()
    return this.getEnrichedState()
  }

  /**
   * Move um serviço pra outro workspace (drag-and-drop no switcher). Se o serviço
   * movido era o ativo, o workspace atual continua em foco e um irmão que ficou
   * nele vira o novo ativo (não "segue" o serviço pro workspace de destino).
   */
  moveServiceToWorkspace(instanceId: string, targetWorkspaceId: string): RendererState {
    if (this.locked) return this.getEnrichedState()
    const state = this.setState((s) => {
      const service = s.services.find((svc) => svc.instanceId === instanceId)
      if (!service || service.workspaceId === targetWorkspaceId) return s
      const targetCount = s.services.filter((svc) => svc.workspaceId === targetWorkspaceId).length
      const services = s.services.map((svc) =>
        svc.instanceId === instanceId ? { ...svc, workspaceId: targetWorkspaceId, order: targetCount } : svc
      )
      let activeInstanceId = s.activeInstanceId
      if (s.activeInstanceId === instanceId) {
        const sibling = services
          .filter((svc) => svc.workspaceId === s.activeWorkspaceId)
          .sort((a, b) => a.order - b.order)[0]
        activeInstanceId = sibling?.instanceId ?? null
      }
      return { ...s, services, activeInstanceId }
    })
    if (state.activeInstanceId && state.activeInstanceId !== instanceId) {
      this.showInstance(state.activeInstanceId)
    } else if (!state.activeInstanceId) {
      this.hideActiveView()
    }
    this.broadcastState()
    return this.getEnrichedState()
  }

  /** Backup/transferência de configuração. Nunca inclui a senha; sessões (login de cada
   * serviço) também ficam de fora — só a "planta" de serviços/workspaces é exportada. */
  exportConfig(): ExportedConfig {
    const { passwordHash: _passwordHash, ...rest } = this.getState()
    return rest
  }

  importConfig(config: ExportedConfig): ImportConfigResult {
    if (this.locked) return { ok: false, error: 'Destrave o app antes de importar.' }
    if (!config || !Array.isArray(config.services) || !Array.isArray(config.workspaces)) {
      return { ok: false, error: 'Arquivo inválido.' }
    }
    if (config.workspaces.length === 0) {
      return { ok: false, error: 'Configuração sem nenhum workspace.' }
    }
    const workspaceIds = new Set(config.workspaces.map((w) => w.id))
    const servicesValid = config.services.every(
      (s) =>
        typeof s.instanceId === 'string' &&
        typeof s.url === 'string' &&
        typeof s.partition === 'string' &&
        workspaceIds.has(s.workspaceId)
    )
    if (!servicesValid) {
      return { ok: false, error: 'Arquivo com serviços inválidos ou de um workspace inexistente.' }
    }
    // Um JSON editado à mão pode ter um activeWorkspaceId que não existe mais
    // entre os workspaces importados — cai pro primeiro nesse caso, em vez de
    // deixar o app numa visão sem workspace válido.
    const activeWorkspaceId = workspaceIds.has(config.activeWorkspaceId)
      ? config.activeWorkspaceId
      : config.workspaces[0].id

    try {
      for (const instanceId of [...this.views.keys()]) {
        this.destroyView(instanceId)
      }
      // Um arquivo exportado por uma versão mais antiga do Deskbox pode não ter
      // os campos mais novos (pinned/iconUrl por serviço, densidade, notificações,
      // bandeja) — ?? cobre esse caso com os valores padrão em vez de undefined.
      this.setState((s) => ({
        ...s,
        services: config.services.map((service) => ({
          ...service,
          pinned: service.pinned ?? false,
          iconUrl: service.iconUrl ?? null
        })),
        workspaces: config.workspaces,
        activeWorkspaceId,
        activeInstanceId: null,
        theme: config.theme,
        proxy: config.proxy,
        hibernateAfterMinutes: config.hibernateAfterMinutes,
        onboardingDismissed: config.onboardingDismissed,
        sidebarDensity: config.sidebarDensity ?? 'comfortable',
        notificationsEnabled: config.notificationsEnabled ?? true,
        minimizeToTray: config.minimizeToTray ?? s.minimizeToTray,
        launchAtLogin: config.launchAtLogin ?? s.launchAtLogin,
        startMinimized: config.startMinimized ?? s.startMinimized
      }))
      const firstInWorkspace = this.servicesInWorkspace(this.getState().activeWorkspaceId)[0]
      if (firstInWorkspace) {
        this.setState((s) => ({ ...s, activeInstanceId: firstInWorkspace.instanceId }))
        this.showInstance(firstInWorkspace.instanceId)
      } else {
        this.hideActiveView()
      }
      this.applyProxyToSession(session.defaultSession).catch((error) => {
        console.error('[deskbox] Falha ao aplicar proxy importado:', error)
      })
      this.broadcastState()
      return { ok: true }
    } catch (error) {
      console.error('[deskbox] Falha ao importar configuração:', error)
      return { ok: false, error: 'Falha ao aplicar a configuração importada.' }
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
    const service = this.getState().services.find((s) => s.instanceId === instanceId)
    const previousCount = service?.unreadCount ?? 0
    this.setState((state) => ({
      ...state,
      services: state.services.map((s) => (s.instanceId === instanceId ? { ...s, unreadCount: count } : s))
    }))
    this.updateBadge()
    this.broadcastState()
    if (service && count > previousCount) {
      this.notifyNewUnread(service)
    }
  }

  /** Notificação nativa do SO quando um serviço ganha mensagem(ns) não lida(s) com a janela em segundo plano. */
  private notifyNewUnread(service: ServiceInstance): void {
    if (this.locked || !this.getState().notificationsEnabled) return
    if (this.window.isFocused() || !Notification.isSupported()) return
    const notification = new Notification({ title: service.name, body: 'Nova mensagem' })
    notification.on('click', () => {
      this.window.show()
      this.window.focus()
      this.selectService(service.instanceId)
    })
    notification.show()
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
    if (this.locked) return {}
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

  /**
   * Estado enviado ao renderer: campos calculados em tempo de execução (hibernated,
   * locked) e nunca inclui passwordHash — vira só o booleano hasPassword.
   *
   * Enquanto trancado, devolve uma versão sanitizada (sem nomes/URLs de serviços,
   * workspaces ou proxy) — sem isso, qualquer chamada direta a
   * `window.deskbox.getState()` pelo DevTools devolveria os dados reais mesmo com
   * a tela de bloqueio em cima, só escondendo visualmente o BrowserView.
   */
  getEnrichedState(): RendererState {
    const { passwordHash, ...state } = this.getState()
    const hasPassword = passwordHash !== null
    if (this.locked) {
      return {
        services: [],
        workspaces: [],
        activeWorkspaceId: state.activeWorkspaceId,
        activeInstanceId: null,
        theme: state.theme,
        proxy: null,
        hibernateAfterMinutes: state.hibernateAfterMinutes,
        onboardingDismissed: state.onboardingDismissed,
        sidebarDensity: state.sidebarDensity,
        notificationsEnabled: state.notificationsEnabled,
        minimizeToTray: state.minimizeToTray,
        launchAtLogin: state.launchAtLogin,
        startMinimized: state.startMinimized,
        hasPassword,
        locked: true
      }
    }
    return {
      ...state,
      hasPassword,
      locked: false,
      services: state.services.map((service) => ({
        ...service,
        hibernated: !this.views.has(service.instanceId),
        loading: this.loadingInstanceIds.has(service.instanceId)
      }))
    }
  }

  addService(payload: AddServicePayload): RendererState {
    if (this.locked) return this.getEnrichedState()
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
      hibernated: false,
      loading: true,
      pinned: false,
      iconUrl: payload.iconUrl?.trim() || null
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

  removeService(instanceId: string): RendererState {
    if (this.locked) return this.getEnrichedState()
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

  reorderServices(order: string[]): RendererState {
    if (this.locked) return this.getEnrichedState()
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
  selectService(instanceId: string): RendererState {
    if (this.locked) return this.getEnrichedState()
    const service = this.getState().services.find((s) => s.instanceId === instanceId)
    if (!service) return this.getEnrichedState()
    this.setState((s) => ({ ...s, activeInstanceId: instanceId, activeWorkspaceId: service.workspaceId }))
    this.showInstance(instanceId)
    this.broadcastState()
    return this.getEnrichedState()
  }

  setTheme(theme: DeskboxState['theme']): RendererState {
    if (this.locked) return this.getEnrichedState()
    this.setState((s) => ({ ...s, theme }))
    this.broadcastState()
    return this.getEnrichedState()
  }

  addWorkspace(name: string): RendererState {
    if (this.locked) return this.getEnrichedState()
    const id = randomUUID()
    this.setState((s) => ({ ...s, workspaces: [...s.workspaces, { id, name: name.trim() || 'Workspace' }] }))
    this.selectWorkspace(id)
    return this.getEnrichedState()
  }

  removeWorkspace(workspaceId: string): RendererState {
    if (this.locked) return this.getEnrichedState()
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

  selectWorkspace(workspaceId: string): RendererState {
    if (this.locked) return this.getEnrichedState()
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
    // Aplica o proxy global antes do primeiro carregamento, pra não vazar a
    // primeira requisição fora do proxy configurado. .catch() evita unhandled
    // rejection se setProxy falhar, e isDestroyed() evita chamar loadURL num
    // BrowserView já removido (ex.: serviço excluído enquanto a promise corria).
    this.applyProxyToSession(partitionSession)
      .catch((error) => console.error('[deskbox] Falha ao aplicar proxy:', error))
      .finally(() => {
        if (!view.webContents.isDestroyed()) {
          view.webContents.loadURL(instance.url)
        }
      })
    this.registerShortcuts(view.webContents)
    view.webContents.on('did-start-loading', () => {
      this.loadingInstanceIds.add(instance.instanceId)
      this.broadcastState()
    })
    view.webContents.on('did-stop-loading', () => {
      this.loadingInstanceIds.delete(instance.instanceId)
      this.broadcastState()
    })
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
    if (!this.overlayOpen && !this.locked) {
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
    this.loadingInstanceIds.delete(instanceId)
  }

  private sweepHibernation(): void {
    const state = this.getState()
    if (state.hibernateAfterMinutes === null) return
    const hibernateAfterMs = state.hibernateAfterMinutes * 60 * 1000
    const pinnedIds = new Set(state.services.filter((s) => s.pinned).map((s) => s.instanceId))
    const now = Date.now()
    let changed = false
    for (const instanceId of [...this.views.keys()]) {
      if (instanceId === this.currentlyShownInstanceId || pinnedIds.has(instanceId)) continue
      const lastActive = this.lastActiveAt.get(instanceId) ?? now
      if (now - lastActive >= hibernateAfterMs) {
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
    const sidebarWidth = this.getState().sidebarDensity === 'compact' ? SIDEBAR_WIDTH_COMPACT : SIDEBAR_WIDTH_COMFORTABLE
    const bounds = this.window.getContentBounds()
    view.setBounds({
      x: sidebarWidth,
      y: 0,
      width: Math.max(0, bounds.width - sidebarWidth),
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

  /**
   * Agenda o envio via microtask em vez de mandar o IPC a cada chamada — várias
   * mutações de estado síncronas (ex.: setState + updateBadge) na mesma função
   * acabavam gerando múltiplos broadcastState() seguidos; coalescidos numa só
   * tick, só o estado final (já computado em getEnrichedState() no flush) é
   * enviado uma única vez.
   */
  private broadcastState(): void {
    if (this.broadcastScheduled) return
    this.broadcastScheduled = true
    queueMicrotask(() => {
      this.broadcastScheduled = false
      if (this.window.isDestroyed()) return
      this.window.webContents.send(IPC.STATE_CHANGED, this.getEnrichedState())
    })
  }
}
