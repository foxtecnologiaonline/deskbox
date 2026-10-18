import { useEffect, useState, useCallback, useMemo } from 'react'
import type { CatalogEntry, DeskboxState, Theme } from '@shared/types'
import Sidebar from './components/Sidebar'
import AddServiceModal from './components/AddServiceModal'
import NewWorkspaceModal from './components/NewWorkspaceModal'
import EmptyState from './components/EmptyState'

export default function App(): JSX.Element {
  const [state, setState] = useState<DeskboxState | null>(null)
  const [catalog, setCatalog] = useState<CatalogEntry[]>([])
  const [modalOpen, setModalOpen] = useState(false)
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false)

  useEffect(() => {
    window.deskbox.getState().then(setState)
    window.deskbox.getCatalog().then(setCatalog)
    const unsubscribe = window.deskbox.onStateChanged(setState)
    return unsubscribe
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
  // o overlay estiver aberto (ver ServicesManager.setOverlayOpen).
  const overlayOpen = modalOpen || workspaceModalOpen
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

  const handleAddCustom = useCallback(async (name: string, url: string) => {
    await window.deskbox.addService({ name, url })
    setModalOpen(false)
  }, [])

  const handleCreateWorkspace = useCallback(async (name: string) => {
    await window.deskbox.addWorkspace(name)
    setWorkspaceModalOpen(false)
  }, [])

  if (!state) {
    return <div className="app-loading">Carregando…</div>
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
        onSelect={(id) => window.deskbox.selectService(id)}
        onRemove={(id) => window.deskbox.removeService(id)}
        onReorder={(order) => window.deskbox.reorderServices(order)}
        onAddClick={() => setModalOpen(true)}
        onThemeToggle={() => window.deskbox.setTheme(nextTheme[state.theme])}
        onSelectWorkspace={(id) => window.deskbox.selectWorkspace(id)}
        onAddWorkspaceClick={() => setWorkspaceModalOpen(true)}
        onRemoveWorkspace={(id) => window.deskbox.removeWorkspace(id)}
      />
      <main className="content-area">
        {servicesInActiveWorkspace.length === 0 && <EmptyState onAddClick={() => setModalOpen(true)} />}
      </main>
      {modalOpen && (
        <AddServiceModal
          catalog={catalog}
          onClose={() => setModalOpen(false)}
          onAddFromCatalog={handleAddFromCatalog}
          onAddCustom={handleAddCustom}
        />
      )}
      {workspaceModalOpen && (
        <NewWorkspaceModal onClose={() => setWorkspaceModalOpen(false)} onCreate={handleCreateWorkspace} />
      )}
    </div>
  )
}
