import { useEffect, useState, useCallback, useMemo } from 'react'
import type { CatalogEntry, RendererState, ServiceInstance, Theme } from '@shared/types'
import Sidebar from './components/Sidebar'
import AddServiceModal from './components/AddServiceModal'
import NewWorkspaceModal from './components/NewWorkspaceModal'
import CommandPalette from './components/CommandPalette'
import SettingsModal from './components/SettingsModal'
import ServiceSettingsModal from './components/ServiceSettingsModal'
import PhonePairingModal from './components/PhonePairingModal'
import LockScreen from './components/LockScreen'
import EmptyState from './components/EmptyState'
import Onboarding from './components/Onboarding'
import ToastHost from './components/ToastHost'

export default function App(): JSX.Element {
  const [state, setState] = useState<RendererState | null>(null)
  const [catalog, setCatalog] = useState<CatalogEntry[]>([])
  const [modalOpen, setModalOpen] = useState(false)
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [serviceContextMenuOpen, setServiceContextMenuOpen] = useState(false)
  const [configuringId, setConfiguringId] = useState<string | null>(null)
  const [phoneModalOpen, setPhoneModalOpen] = useState(false)
  const [memoryUsage, setMemoryUsage] = useState<Record<string, number>>({})

  useEffect(() => {
    window.deskbox.getState().then(setState)
    window.deskbox.getCatalog().then(setCatalog)
    const unsubscribe = window.deskbox.onStateChanged(setState)
    return unsubscribe
  }, [])

  // Só pra mostrar o ganho real da hibernação na sidebar; não precisa ser em
  // tempo real, então um polling simples é suficiente — e pausa quando a janela
  // está oculta/minimizada (document.hidden), já que ninguém está olhando o
  // número e não vale gastar IPC + app.getAppMetrics() à toa em segundo plano.
  useEffect(() => {
    let cancelled = false
    let interval: ReturnType<typeof setInterval> | null = null

    const poll = (): void => {
      window.deskbox.getMemoryUsage().then((usage) => {
        if (!cancelled) setMemoryUsage(usage)
      })
    }
    const startPolling = (): void => {
      if (interval) return
      poll()
      interval = setInterval(poll, 15000)
    }
    const stopPolling = (): void => {
      if (!interval) return
      clearInterval(interval)
      interval = null
    }
    const handleVisibilityChange = (): void => {
      if (document.hidden) stopPolling()
      else startPolling()
    }

    if (!document.hidden) startPolling()
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      cancelled = true
      stopPolling()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  useEffect(() => {
    return window.deskbox.onOpenCommandPalette(() => setPaletteOpen(true))
  }, [])

  useEffect(() => {
    if (!state) return
    const root = document.documentElement
    if (state.theme === 'system') {
      root.removeAttribute('data-theme')
    } else {
      root.setAttribute('data-theme', state.theme)
    }
  }, [state?.theme])

  // Um BrowserView sempre fica por cima do DOM da janela (camada nativa, fora do
  // stacking context da página), então os modais abaixo ficariam invisíveis atrás
  // do serviço ativo se o processo principal não desanexasse o BrowserView enquanto
  // o overlay estiver aberto (ver ServicesManager.setOverlayOpen). O cartão de
  // onboarding entra na mesma regra por segurança, mesmo só aparecendo na prática
  // quando ainda não há nenhum serviço (logo, nenhum BrowserView pra esconder).
  const onboardingOpen = Boolean(state && !state.onboardingDismissed)
  const overlayOpen =
    modalOpen ||
    workspaceModalOpen ||
    paletteOpen ||
    settingsOpen ||
    onboardingOpen ||
    serviceContextMenuOpen ||
    configuringId !== null ||
    phoneModalOpen
  useEffect(() => {
    window.deskbox.setOverlayOpen(overlayOpen)
  }, [overlayOpen])

  const servicesInActiveWorkspace = useMemo(
    () => (state ? state.services.filter((service) => service.workspaceId === state.activeWorkspaceId) : []),
    [state]
  )

  const handleAddFromCatalog = useCallback(async (catalogId: string) => {
    await window.deskbox.addService({ catalogId })
    setModalOpen(false)
  }, [])

  const handleAddCustom = useCallback(async (name: string, url: string, iconUrl?: string) => {
    await window.deskbox.addService({ name, url, iconUrl })
    setModalOpen(false)
  }, [])

  const handleDuplicateService = useCallback(async (service: ServiceInstance) => {
    if (service.catalogId !== 'custom') {
      await window.deskbox.addService({ catalogId: service.catalogId })
    } else {
      await window.deskbox.addService({ name: service.name, url: service.url, iconUrl: service.iconUrl ?? undefined })
    }
  }, [])

  const handleCreateWorkspace = useCallback(async (name: string) => {
    await window.deskbox.addWorkspace(name)
    setWorkspaceModalOpen(false)
  }, [])

  if (!state) {
    return <div className="app-loading">Carregando…</div>
  }

  if (state.locked) {
    return <LockScreen />
  }

  const nextTheme: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' }

  return (
    <div className="app-shell">
      <Sidebar
        services={servicesInActiveWorkspace}
        workspaces={state.workspaces}
        activeWorkspaceId={state.activeWorkspaceId}
        activeInstanceId={state.activeInstanceId}
        theme={state.theme}
        hasPassword={state.hasPassword}
        density={state.sidebarDensity}
        memoryUsage={memoryUsage}
        onSelect={(id) => window.deskbox.selectService(id)}
        onRemove={(id) => window.deskbox.removeService(id)}
        onReorder={(order) => window.deskbox.reorderServices(order)}
        onMoveToWorkspace={(instanceId, workspaceId) => window.deskbox.moveServiceToWorkspace(instanceId, workspaceId)}
        onTogglePinned={(id) => window.deskbox.toggleServicePinned(id)}
        onDuplicate={handleDuplicateService}
        onConfigure={(service) => setConfiguringId(service.instanceId)}
        onContextMenuOpenChange={setServiceContextMenuOpen}
        onAddClick={() => setModalOpen(true)}
        onThemeToggle={() => window.deskbox.setTheme(nextTheme[state.theme])}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onLockNow={() => window.deskbox.lockNow()}
        onSelectWorkspace={(id) => window.deskbox.selectWorkspace(id)}
        onAddWorkspaceClick={() => setWorkspaceModalOpen(true)}
        onRemoveWorkspace={(id) => window.deskbox.removeWorkspace(id)}
      />
      <main className="content-area">
        {servicesInActiveWorkspace.length === 0 && (
          <EmptyState catalog={catalog} onAddClick={() => setModalOpen(true)} onQuickAdd={handleAddFromCatalog} />
        )}
      </main>
      {modalOpen && (
        <AddServiceModal
          catalog={catalog}
          onClose={() => setModalOpen(false)}
          onAddFromCatalog={handleAddFromCatalog}
          onAddCustom={handleAddCustom}
          onAddPhone={() => {
            setModalOpen(false)
            setPhoneModalOpen(true)
          }}
        />
      )}
      {workspaceModalOpen && (
        <NewWorkspaceModal onClose={() => setWorkspaceModalOpen(false)} onCreate={handleCreateWorkspace} />
      )}
      {paletteOpen && (
        <CommandPalette
          state={state}
          onClose={() => setPaletteOpen(false)}
          onSelectService={(id) => window.deskbox.selectService(id)}
          onSelectWorkspace={(id) => window.deskbox.selectWorkspace(id)}
          onAddService={() => {
            setPaletteOpen(false)
            setModalOpen(true)
          }}
          onAddWorkspace={() => {
            setPaletteOpen(false)
            setWorkspaceModalOpen(true)
          }}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          hasPassword={state.hasPassword}
          proxy={state.proxy}
          hibernateAfterMinutes={state.hibernateAfterMinutes}
          sidebarDensity={state.sidebarDensity}
          notificationsEnabled={state.notificationsEnabled}
          minimizeToTray={state.minimizeToTray}
          launchAtLogin={state.launchAtLogin}
          startMinimized={state.startMinimized}
          autoUpdate={state.autoUpdate}
          sync={state.sync}
          pendingJsCount={state.services.filter((service) => service.jsPendingApproval).length}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {configuringId && state.services.find((service) => service.instanceId === configuringId) && (
        <ServiceSettingsModal
          key={configuringId}
          service={state.services.find((service) => service.instanceId === configuringId)!}
          onClose={() => setConfiguringId(null)}
        />
      )}
      {phoneModalOpen && <PhonePairingModal onClose={() => setPhoneModalOpen(false)} />}
      {onboardingOpen && <Onboarding onDismiss={() => window.deskbox.dismissOnboarding()} />}
      <ToastHost />
    </div>
  )
}
