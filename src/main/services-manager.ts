import { createHash, randomUUID } from 'crypto'
import { BrowserView, BrowserWindow, ipcMain, session, app, Notification } from 'electron'
import { join } from 'path'
import type {
  AddServicePayload,
  DeskboxState,
  ExportedConfig,
  ImportConfigResult,
  PhoneEvent,
  ProxyConfig,
  RendererState,
  ServiceInstance,
  ServiceSettingsPayload,
  SetPasswordResult,
  SidebarDensity,
  SyncView
} from '@shared/types'
import { IPC } from '@shared/ipc'
import { PHONE_CATALOG_ID, PHONE_ICON, phoneDeviceIdFromUrl, phoneServiceUrl } from '@shared/phone'
import { CATALOG, findCatalogEntry } from './catalog'
import { hashPassword, verifyPassword } from './password'
import type { PhoneServer } from './phone/phone-server'
import { applyPayload, isHttpUrl, MAX_CUSTOM_CODE_LENGTH, parseSyncPayload, type SyncPayload } from './sync/payload'

const SIDEBAR_WIDTH_COMFORTABLE = 72
const SIDEBAR_WIDTH_COMPACT = 56
const HIBERNATION_SWEEP_INTERVAL_MS = 60 * 1000

function hashJs(code: string): string {
  return createHash('sha256').update(code, 'utf-8').digest('hex')
}

/** JS personalizado só executa se este dispositivo aprovou exatamente este código (ver ServiceInstance.approvedJsHash). */
function isJsApproved(service: ServiceInstance): boolean {
  return !service.customJs.trim() || service.approvedJsHash === hashJs(service.customJs)
}

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
  /** instanceIds que já mandaram ao menos um SERVICE_UNREAD — ver handleUnreadMessage. */
  private seenUnreadInstanceIds = new Set<string>()
  /** true enquanto um modal do renderer (overlay React) precisa ficar visível. */
  private overlayOpen = false
  /** true quando o app está trancado por senha mestre — nenhum BrowserView é exibido. */
  private locked = false
  /** Coalesce múltiplas chamadas síncronas de broadcastState() num único envio de IPC. */
  private broadcastScheduled = false
  /** Chave do CSS injetado por instância (pra remover/trocar sem recarregar a página). */
  private cssKeys = new Map<string, string>()
  private syncViewProvider: () => SyncView | null = () => null
  private unlockListeners = new Set<() => void>()
  private phone: PhoneServer | null = null

  constructor(
    window: BrowserWindow,
    getState: () => DeskboxState,
    setState: (updater: (state: DeskboxState) => DeskboxState) => DeskboxState,
    private replaceState: (next: DeskboxState, remoteUpdatedAt: number) => DeskboxState
  ) {
    this.window = window
    this.getState = getState
    this.setState = setState
  }

  attachPhoneServer(phone: PhoneServer): void {
    this.phone = phone
  }

  /** Eventos do servidor de celular: ao parear, o celular vira um serviço na sidebar (uma vez por aparelho). */
  handlePhoneEvent(event: PhoneEvent): void {
    if (event.type === 'paired' && !this.locked) {
      const url = phoneServiceUrl(event.deviceId)
      const exists = this.getState().services.some((s) => s.url === url)
      if (!exists) this.addPhoneService(event.deviceId, event.name)
    }
    // Trancado: nada (nem o nome do aparelho) vai pro renderer.
    if (!this.locked && !this.window.isDestroyed()) this.window.webContents.send(IPC.PHONE_CHANGED, event)
  }

  private addPhoneService(deviceId: string, name: string): void {
    const instance = this.buildInstance({
      catalogId: PHONE_CATALOG_ID,
      name: name || 'Celular Android',
      url: phoneServiceUrl(deviceId),
      domain: '127.0.0.1',
      iconUrl: PHONE_ICON
    })
    this.setState((s) => ({ ...s, services: [...s.services, instance], activeInstanceId: instance.instanceId }))
    this.showInstance(instance.instanceId)
    this.broadcastState()
  }

  isLocked(): boolean {
    return this.locked
  }

  setSyncViewProvider(provider: () => SyncView | null): void {
    this.syncViewProvider = provider
  }

  onUnlocked(listener: () => void): void {
    this.unlockListeners.add(listener)
  }

  /** Reenvia o estado ao renderer (ex.: status do sync mudou). */
  refreshState(): void {
    this.broadcastState()
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
      this.unlockListeners.forEach((listener) => listener())
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
    for (const [instanceId, view] of this.views) {
      tasks.push(this.applyProxyToSession(view.webContents.session, instanceId))
    }
    await Promise.all(tasks)
    this.broadcastState()
    return this.getEnrichedState()
  }

  /**
   * Proxy efetivo de uma sessão: o do serviço (se tiver) vence o global. Use "direct://" no proxy
   * do serviço pra ele ignorar o proxy global.
   */
  private async applyProxyToSession(target: Electron.Session, instanceId?: string): Promise<void> {
    const state = this.getState()
    const service = instanceId ? state.services.find((s) => s.instanceId === instanceId) : undefined
    const own = service?.proxy?.rules.trim()
    const proxyRules = own || state.proxy?.rules.trim() || ''
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

  /**
   * Boilerplate comum a toda configuração simples (checar lock, mesclar no
   * estado, notificar o renderer): `compute` só roda se o app estiver
   * destrancado, já que não há por que calcular o patch de um `setState` que
   * nem vai acontecer.
   */
  private patchState(compute: (state: DeskboxState) => Partial<DeskboxState>): RendererState {
    if (this.locked) return this.getEnrichedState()
    this.setState((s) => ({ ...s, ...compute(s) }))
    this.broadcastState()
    return this.getEnrichedState()
  }

  /** `pinned: true` faz o serviço nunca hibernar sozinho, mesmo com hibernação automática ativa. */
  toggleServicePinned(instanceId: string): RendererState {
    return this.patchState((s) => ({
      services: s.services.map((service) =>
        service.instanceId === instanceId ? { ...service, pinned: !service.pinned } : service
      )
    }))
  }

  setSidebarDensity(density: SidebarDensity): RendererState {
    if (this.locked) return this.getEnrichedState()
    const result = this.patchState(() => ({ sidebarDensity: density }))
    this.layout()
    return result
  }

  setNotificationsEnabled(enabled: boolean): RendererState {
    return this.patchState(() => ({ notificationsEnabled: enabled }))
  }

  /** Persistência pura — o efeito colateral (criar/destruir o Tray) é feito pelo chamador em index.ts. */
  setMinimizeToTray(enabled: boolean): RendererState {
    return this.patchState(() => ({ minimizeToTray: enabled }))
  }

  /** Persistência pura — o efeito colateral (app.setLoginItemSettings) é feito pelo chamador em index.ts. */
  setLaunchAtLogin(enabled: boolean): RendererState {
    return this.patchState(() => ({ launchAtLogin: enabled }))
  }

  setStartMinimized(enabled: boolean): RendererState {
    return this.patchState(() => ({ startMinimized: enabled }))
  }

  setAutoUpdate(enabled: boolean): RendererState {
    return this.patchState(() => ({ autoUpdate: enabled }))
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

  /**
   * Backup/transferência manual. Nunca inclui a senha; sessões (login de cada serviço) também ficam
   * de fora — só a "planta" de serviços/workspaces. A aprovação de JS é local e não viaja.
   */
  exportConfig(): ExportedConfig {
    const { passwordHash: _passwordHash, sync: _sync, configUpdatedAt: _updatedAt, ...rest } = this.getState()
    return {
      ...rest,
      services: rest.services
        .filter((service) => service.catalogId !== PHONE_CATALOG_ID)
        .map((service) => ({ ...service, approvedJsHash: null, jsPendingApproval: false }))
    }
  }

  importConfig(config: ExportedConfig): ImportConfigResult {
    if (this.locked) return { ok: false, error: 'Destrave o app antes de importar.' }
    if (!config || !Array.isArray(config.services) || !Array.isArray(config.workspaces)) {
      return { ok: false, error: 'Arquivo inválido.' }
    }
    if (config.workspaces.length === 0) {
      return { ok: false, error: 'Configuração sem nenhum workspace.' }
    }
    // Mesma validação do sync: só http(s), tamanhos limitados, workspace existente etc. Um arquivo
    // de fora nunca pode apontar um serviço pra file:// nem trazer JS gigante.
    const payload = parseSyncPayload(config)
    if (!payload) {
      return { ok: false, error: 'Arquivo com serviços inválidos, de um workspace inexistente ou com URL não permitida.' }
    }
    const rawProxyById = new Map<string, ServiceInstance['proxy']>()
    for (const raw of config.services as Array<Partial<ServiceInstance>>) {
      const rules = raw.proxy?.rules
      if (typeof raw.instanceId === 'string' && typeof rules === 'string' && rules.trim()) {
        rawProxyById.set(raw.instanceId, { rules: rules.trim() })
      }
    }
    const globalRules = (config.proxy as ProxyConfig | null)?.rules
    const globalProxy = typeof globalRules === 'string' && globalRules.trim() ? { rules: globalRules.trim() } : null

    try {
      for (const instanceId of [...this.views.keys()]) {
        this.destroyView(instanceId)
      }
      this.seenUnreadInstanceIds.clear()
      // applyPayload preserva o que é só deste dispositivo (bandeja, iniciar com o sistema, sync,
      // aprovação de JS já dada a código idêntico) — um arquivo de fora não liga/desliga isso.
      this.setState((s) => {
        const next = applyPayload(s, payload)
        return {
          ...next,
          proxy: globalProxy,
          activeInstanceId: null,
          services: next.services.map((service) => ({ ...service, proxy: rawProxyById.get(service.instanceId) ?? null }))
        }
      })
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

  /**
   * Aplica uma configuração vinda do sync de outro dispositivo. Views de serviços removidos ou
   * cuja URL/CSS/JS mudou são descarregadas (recriadas sob demanda, já com a config nova).
   */
  applySyncedConfig(payload: SyncPayload, remoteUpdatedAt: number): void {
    if (this.locked) return
    const local = this.getState()
    const next = applyPayload(local, payload)
    const nextById = new Map(next.services.map((s) => [s.instanceId, s]))
    const localById = new Map(local.services.map((s) => [s.instanceId, s]))
    for (const instanceId of [...this.views.keys()]) {
      const before = localById.get(instanceId)
      const after = nextById.get(instanceId)
      if (
        !before ||
        !after ||
        before.url !== after.url ||
        before.customCss !== after.customCss ||
        before.customJs !== after.customJs
      ) {
        this.destroyView(instanceId)
      }
    }
    for (const instanceId of [...this.seenUnreadInstanceIds]) {
      if (!nextById.has(instanceId)) this.seenUnreadInstanceIds.delete(instanceId)
    }
    this.replaceState(next, remoteUpdatedAt)
    const state = this.getState()
    const activeId = state.activeInstanceId ?? this.servicesInWorkspace(state.activeWorkspaceId)[0]?.instanceId ?? null
    if (activeId) {
      if (state.activeInstanceId !== activeId) this.setState((s) => ({ ...s, activeInstanceId: activeId }))
      this.showInstance(activeId)
    } else {
      this.hideActiveView()
    }
    this.updateBadge()
    this.broadcastState()
  }

  /** Proxy próprio, CSS e JS de um serviço. Salvar = o usuário revisou o JS → aprova o código atual. */
  async setServiceSettings(payload: ServiceSettingsPayload): Promise<RendererState> {
    if (this.locked) return this.getEnrichedState()
    const service = this.getState().services.find((s) => s.instanceId === payload.instanceId)
    if (!service) return this.getEnrichedState()
    if (payload.customCss.length > MAX_CUSTOM_CODE_LENGTH || payload.customJs.length > MAX_CUSTOM_CODE_LENGTH) {
      return this.getEnrichedState()
    }
    const proxyRules = payload.proxy?.rules.trim() ?? ''
    const proxy = proxyRules ? { rules: proxyRules } : null
    const proxyChanged = proxyRules !== (service.proxy?.rules.trim() ?? '')
    const jsChanged = payload.customJs !== service.customJs
    const jsWasPending = service.customJs.trim() !== '' && !isJsApproved(service)
    const cssChanged = payload.customCss !== service.customCss

    this.setState((s) => ({
      ...s,
      services: s.services.map((sv) =>
        sv.instanceId === payload.instanceId
          ? {
              ...sv,
              proxy,
              customCss: payload.customCss,
              customJs: payload.customJs,
              approvedJsHash: payload.customJs.trim() ? hashJs(payload.customJs) : null
            }
          : sv
      )
    }))

    const view = this.views.get(payload.instanceId)
    if (view && !view.webContents.isDestroyed()) {
      try {
        if (proxyChanged) await this.applyProxyToSession(view.webContents.session, payload.instanceId)
        // Proxy novo e JS (novo ou recém-aprovado) só valem numa página limpa → recarrega.
        // Só CSS muda sem recarregar (troca a folha injetada, preservando o estado da página).
        if (proxyChanged || jsChanged || (jsWasPending && payload.customJs.trim())) {
          view.webContents.reload()
        } else if (cssChanged) {
          await this.refreshCss(payload.instanceId, view.webContents)
        }
      } catch (error) {
        console.error('[deskbox] Falha ao aplicar configurações do serviço:', error)
      }
    }
    this.broadcastState()
    return this.getEnrichedState()
  }

  /** Remover o serviço de celular também revoga o pareamento (o token deixa de valer). */
  private forgetPhoneOf(instanceId: string): void {
    const service = this.getState().services.find((s) => s.instanceId === instanceId)
    if (service?.catalogId !== PHONE_CATALOG_ID) return
    const deviceId = phoneDeviceIdFromUrl(service.url)
    if (deviceId) this.phone?.forget(deviceId)
  }

  private async refreshCss(instanceId: string, webContents: Electron.WebContents): Promise<void> {
    const previousKey = this.cssKeys.get(instanceId)
    this.cssKeys.delete(instanceId)
    if (previousKey) await webContents.removeInsertedCSS(previousKey).catch(() => undefined)
    const service = this.getState().services.find((s) => s.instanceId === instanceId)
    if (!service || !service.customCss.trim() || webContents.isDestroyed()) return
    const key = await webContents.insertCSS(service.customCss)
    this.cssKeys.set(instanceId, key)
  }

  /** Roda a cada carregamento de página do serviço (dom-ready): CSS sempre, JS só se aprovado neste dispositivo. */
  private async injectCustomizations(instanceId: string, webContents: Electron.WebContents): Promise<void> {
    const service = this.getState().services.find((s) => s.instanceId === instanceId)
    if (!service || webContents.isDestroyed()) return
    try {
      await this.refreshCss(instanceId, webContents)
      if (service.customJs.trim() && isJsApproved(service)) {
        await webContents.executeJavaScript(service.customJs, true)
      }
    } catch (error) {
      console.error(`[deskbox] Falha ao aplicar CSS/JS personalizado em "${service.name}":`, error)
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
    // A primeira leitura de um BrowserView recém-criado (serviço adicionado agora,
    // ou reativado depois de hibernar) só estabelece a base — nunca notifica. Sem
    // isso, uma conta restaurada de sessão com não lidos pré-existentes (ex.:
    // WhatsApp com 5 mensagens já não lidas antes mesmo de abrir no Deskbox) geraria
    // uma notificação de "mensagem nova" bem na hora de adicionar a conta.
    const isFirstReport = !this.seenUnreadInstanceIds.has(instanceId)
    this.seenUnreadInstanceIds.add(instanceId)
    this.setState((state) => ({
      ...state,
      services: state.services.map((s) => (s.instanceId === instanceId ? { ...s, unreadCount: count } : s))
    }))
    this.updateBadge()
    this.broadcastState()
    if (service && !isFirstReport && count > previousCount) {
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
        autoUpdate: state.autoUpdate,
        configUpdatedAt: state.configUpdatedAt,
        sync: null,
        hasPassword,
        locked: true
      }
    }
    const { sync: _sync, ...publicState } = state
    return {
      ...publicState,
      hasPassword,
      locked: false,
      sync: this.syncViewProvider(),
      services: state.services.map((service) => ({
        ...service,
        hibernated: !this.views.has(service.instanceId),
        loading: this.loadingInstanceIds.has(service.instanceId),
        jsPendingApproval: !isJsApproved(service)
      }))
    }
  }

  addService(payload: AddServicePayload): RendererState {
    if (this.locked) return this.getEnrichedState()
    const catalogEntry = payload.catalogId ? findCatalogEntry(payload.catalogId) : undefined
    const name = catalogEntry?.name ?? payload.name ?? 'Site personalizado'
    const url = catalogEntry?.url ?? payload.url?.trim()
    // Só http(s): uma URL inválida (ou file:, javascript:...) nunca vira serviço — além de não
    // carregar, quebraria a validação do arquivo de sync.
    if (!isHttpUrl(url)) {
      return this.getEnrichedState()
    }
    const iconUrl = payload.iconUrl?.trim()
    const instance = this.buildInstance({
      catalogId: catalogEntry?.id ?? 'custom',
      name: name.trim().slice(0, 80) || 'Site personalizado',
      url,
      domain: catalogEntry?.domain ?? domainFromUrl(url),
      iconUrl: isHttpUrl(iconUrl) ? iconUrl : null
    })
    this.setState((s) => ({
      ...s,
      services: [...s.services, instance],
      activeInstanceId: instance.instanceId
    }))
    this.showInstance(instance.instanceId)
    this.broadcastState()
    return this.getEnrichedState()
  }

  private buildInstance(
    base: Pick<ServiceInstance, 'catalogId' | 'name' | 'url' | 'domain' | 'iconUrl'>
  ): ServiceInstance {
    const workspaceId = this.getState().activeWorkspaceId
    const instanceId = randomUUID()
    return {
      ...base,
      instanceId,
      partition: `persist:deskbox-${instanceId}`,
      workspaceId,
      order: this.servicesInWorkspace(workspaceId).length,
      muted: false,
      unreadCount: 0,
      hibernated: false,
      loading: true,
      pinned: false,
      proxy: null,
      customCss: '',
      customJs: '',
      approvedJsHash: null,
      jsPendingApproval: false
    }
  }

  removeService(instanceId: string): RendererState {
    if (this.locked) return this.getEnrichedState()
    this.forgetPhoneOf(instanceId)
    this.destroyView(instanceId)
    this.seenUnreadInstanceIds.delete(instanceId)
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
      this.forgetPhoneOf(service.instanceId)
      this.destroyView(service.instanceId)
      this.seenUnreadInstanceIds.delete(service.instanceId)
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

  /** Serviços normais carregam a URL salva; o de celular aponta pro viewer local (porta dinâmica). */
  private async resolveServiceUrl(instance: ServiceInstance): Promise<string> {
    if (instance.catalogId !== PHONE_CATALOG_ID) return instance.url
    const deviceId = phoneDeviceIdFromUrl(instance.url)
    if (!deviceId || !this.phone) throw new Error('Servidor de celular indisponível.')
    return this.phone.viewerUrl(deviceId)
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
    this.applyProxyToSession(partitionSession, instance.instanceId)
      .catch((error) => console.error('[deskbox] Falha ao aplicar proxy:', error))
      .then(() => this.resolveServiceUrl(instance))
      .then((url) => {
        if (!view.webContents.isDestroyed()) {
          void view.webContents.loadURL(url)
        }
      })
      .catch((error) => console.error(`[deskbox] Falha ao carregar "${instance.name}":`, error))
    this.registerShortcuts(view.webContents)
    view.webContents.on('dom-ready', () => {
      void this.injectCustomizations(instance.instanceId, view.webContents)
    })
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
    this.cssKeys.delete(instanceId)
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
