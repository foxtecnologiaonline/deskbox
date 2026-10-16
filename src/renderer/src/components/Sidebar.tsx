import { useState } from 'react'
import type { ServiceInstance, Theme } from '@shared/types'
import { faviconUrl } from '@shared/favicon'

interface SidebarProps {
  services: ServiceInstance[]
  activeInstanceId: string | null
  theme: Theme
  onSelect: (instanceId: string) => void
  onRemove: (instanceId: string) => void
  onReorder: (order: string[]) => void
  onAddClick: () => void
  onThemeToggle: () => void
}

export default function Sidebar({
  services,
  activeInstanceId,
  theme,
  onSelect,
  onRemove,
  onReorder,
  onAddClick,
  onThemeToggle
}: SidebarProps): JSX.Element {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const sorted = [...services].sort((a, b) => a.order - b.order)

  function handleDrop(targetId: string): void {
    if (!draggingId || draggingId === targetId) return
    const order = sorted.map((s) => s.instanceId)
    const from = order.indexOf(draggingId)
    const to = order.indexOf(targetId)
    order.splice(from, 1)
    order.splice(to, 0, draggingId)
    onReorder(order)
    setDraggingId(null)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-services">
        {sorted.map((service) => (
          <div
            key={service.instanceId}
            className={`service-icon-wrap ${service.instanceId === activeInstanceId ? 'active' : ''}`}
            draggable
            onDragStart={() => setDraggingId(service.instanceId)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => handleDrop(service.instanceId)}
            title={service.name}
          >
            <button className="service-icon" onClick={() => onSelect(service.instanceId)}>
              <img src={faviconUrl(service.domain)} alt={service.name} />
              {service.unreadCount > 0 && (
                <span className="unread-badge">{service.unreadCount > 99 ? '99+' : service.unreadCount}</span>
              )}
            </button>
            <button
              className="remove-service"
              title="Remover"
              onClick={(e) => {
                e.stopPropagation()
                onRemove(service.instanceId)
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button className="add-service" onClick={onAddClick} title="Adicionar serviço">
          +
        </button>
      </div>
      <div className="sidebar-footer">
        <button className="theme-toggle" onClick={onThemeToggle} title="Alternar tema">
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
      </div>
    </aside>
  )
}
