import { useEffect, useMemo, useRef, useState } from 'react'
import type { DeskboxState } from '@shared/types'
import { faviconUrl } from '@shared/favicon'

interface CommandPaletteProps {
  state: DeskboxState
  onClose: () => void
  onSelectService: (instanceId: string) => void
  onSelectWorkspace: (workspaceId: string) => void
  onAddService: () => void
  onAddWorkspace: () => void
}

interface PaletteItem {
  id: string
  label: string
  sublabel?: string
  icon?: string
  onRun: () => void
}

export default function CommandPalette({
  state,
  onClose,
  onSelectService,
  onSelectWorkspace,
  onAddService,
  onAddWorkspace
}: CommandPaletteProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const items = useMemo<PaletteItem[]>(() => {
    const workspaceById = new Map(state.workspaces.map((w) => [w.id, w]))
    const serviceItems: PaletteItem[] = [...state.services]
      .sort((a, b) => a.order - b.order)
      .map((service) => {
        const inOtherWorkspace = service.workspaceId !== state.activeWorkspaceId
        return {
          id: `service:${service.instanceId}`,
          label: service.name,
          sublabel: inOtherWorkspace ? workspaceById.get(service.workspaceId)?.name : undefined,
          icon: faviconUrl(service.domain),
          onRun: () => onSelectService(service.instanceId)
        }
      })
    const workspaceItems: PaletteItem[] = state.workspaces
      .filter((w) => w.id !== state.activeWorkspaceId)
      .map((workspace) => ({
        id: `workspace:${workspace.id}`,
        label: `Ir para workspace "${workspace.name}"`,
        onRun: () => onSelectWorkspace(workspace.id)
      }))
    const actionItems: PaletteItem[] = [
      { id: 'action:add-service', label: '+ Adicionar serviço…', onRun: onAddService },
      { id: 'action:add-workspace', label: '+ Novo workspace…', onRun: onAddWorkspace }
    ]
    return [...serviceItems, ...workspaceItems, ...actionItems]
  }, [state, onSelectService, onSelectWorkspace, onAddService, onAddWorkspace])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((item) => item.label.toLowerCase().includes(q))
  }, [items, query])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  function run(item: PaletteItem | undefined): void {
    if (!item) return
    item.onRun()
    onClose()
  }

  function handleKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(filtered[activeIndex])
    } else if (e.key === 'Escape') {
      onClose()
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-search"
          placeholder="Buscar serviço, workspace ou ação…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="palette-list">
          {filtered.map((item, index) => (
            <button
              key={item.id}
              className={`palette-item ${index === activeIndex ? 'active' : ''}`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => run(item)}
            >
              {item.icon && <img src={item.icon} alt="" />}
              <span className="palette-item-label">{item.label}</span>
              {item.sublabel && <span className="palette-item-sublabel">{item.sublabel}</span>}
            </button>
          ))}
          {filtered.length === 0 && <p className="catalog-empty">Nada encontrado.</p>}
        </div>
      </div>
    </div>
  )
}
