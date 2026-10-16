import { useEffect, useState, useCallback } from 'react'
import type { CatalogEntry, DeskboxState } from '@shared/types'
import Sidebar from './components/Sidebar'
import AddServiceModal from './components/AddServiceModal'
import EmptyState from './components/EmptyState'

export default function App(): JSX.Element {
  const [state, setState] = useState<DeskboxState | null>(null)
  const [catalog, setCatalog] = useState<CatalogEntry[]>([])
  const [modalOpen, setModalOpen] = useState(false)

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

  const handleAddFromCatalog = useCallback(async (catalogId: string) => {
    await window.deskbox.addService({ catalogId })
    setModalOpen(false)
  }, [])

  const handleAddCustom = useCallback(async (name: string, url: string) => {
    await window.deskbox.addService({ name, url })
    setModalOpen(false)
  }, [])

  if (!state) {
    return <div className="app-loading">Carregando…</div>
  }

  return (
    <div className="app-shell">
      <Sidebar
        services={state.services}
        activeInstanceId={state.activeInstanceId}
        theme={state.theme}
        onSelect={(id) => window.deskbox.selectService(id)}
        onRemove={(id) => window.deskbox.removeService(id)}
        onReorder={(order) => window.deskbox.reorderServices(order)}
        onAddClick={() => setModalOpen(true)}
        onThemeToggle={() => {
          const next = state.theme === 'dark' ? 'light' : 'dark'
          window.deskbox.setTheme(next)
        }}
      />
      <main className="content-area">
        {state.services.length === 0 && <EmptyState onAddClick={() => setModalOpen(true)} />}
      </main>
      {modalOpen && (
        <AddServiceModal
          catalog={catalog}
          onClose={() => setModalOpen(false)}
          onAddFromCatalog={handleAddFromCatalog}
          onAddCustom={handleAddCustom}
        />
      )}
    </div>
  )
}
