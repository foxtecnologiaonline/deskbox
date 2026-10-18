import { useState } from 'react'
import type { ServiceInstance, Theme, Workspace } from '@shared/types'
import { faviconUrl } from '@shared/favicon'
import WorkspaceSwitcher from './WorkspaceSwitcher'

const THEME_ICON: Record<Theme, string> = { system: '🖥️', light: '☀️', dark: '🌙' }
const THEME_LABEL: Record<Theme, string> = { system: 'Sistema', light: 'Claro', dark: 'Escuro' }

interface SidebarProps {
  services: ServiceInstance[]
  workspaces: Workspace[]
  activeWorkspaceId: string
  activeInstanceId: string | null
  theme: Theme
  hasPassword: boolean
  memoryUsage: Record<string, number>
  onSelect: (instanceId: string) => void
  onRemove: (instanceId: string) => void
  onReorder: (order: string[]) => void
  onMoveToWorkspace: (instanceId: string, workspaceId: string) => void
  onAddClick: () => void
  onThemeToggle: () => void
  onOpenPalette: () => void
  onOpenSettings: () => void
  onLockNow: () => void
  onSelectWorkspace: (workspaceId: string) => void
  onAddWorkspaceClick: () => void
  onRemoveWorkspace: (workspaceId: string) => void
}

export default function Sidebar({
  services,
  workspaces,
  activeWorkspaceId,
  activeInstanceId,
  theme,
  hasPassword,
  memoryUsage,
  onSelect,
  onRemove,
  onReorder,
  onMoveToWorkspace,
  onAddClick,
  onThemeToggle,
  onOpenPalette,
  onOpenSettings,
  onLockNow,
  onSelectWorkspace,
  onAddWorkspaceClick,
  onRemoveWorkspace
}: SidebarProps): JSX.Element {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const sorted = [...services].sort((a, b) => a.order - b.order)
  const totalMemoryMb = Object.values(memoryUsage).reduce((sum, mb) => sum + mb, 0)

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
      <WorkspaceSwitcher
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        draggingServiceId={draggingId}
        onSelect={onSelectWorkspace}
        onAddClick={onAddWorkspaceClick}
        onRemove={onRemoveWorkspace}
        onDropService={(instanceId, workspaceId) => {
          onMoveToWorkspace(instanceId, workspaceId)
          setDraggingId(null)
        }}
      />
      <div className="sidebar-divider" />
      <div className="sidebar-services">
        {sorted.map((service) => (
          <div
            key={service.instanceId}
            className={`service-icon-wrap ${service.instanceId === activeInstanceId ? 'active' : ''} ${service.hibernated ? 'hibernated' : ''}`}
            draggable
            onDragStart={() => setDraggingId(service.instanceId)}
            onDragEnd={() => setDraggingId(null)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => handleDrop(service.instanceId)}
            title={
              service.hibernated
                ? `${service.name} (hibernado — clique para reativar)`
                : memoryUsage[service.instanceId] !== undefined
                  ? `${service.name} — ${memoryUsage[service.instanceId]} MB`
                  : service.name
            }
          >
            <button className="service-icon" onClick={() => onSelect(service.instanceId)}>
              <img src={faviconUrl(service.domain)} alt={service.name} loading="lazy" />
              {service.loading && !service.hibernated && <span className="service-spinner" />}
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
        {totalMemoryMb > 0 && (
          <span className="memory-total" title="Uso de memória dos serviços ativos (hibernados não contam)">
            {totalMemoryMb} MB
          </span>
        )}
        {hasPassword && (
          <button className="lock-trigger" onClick={onLockNow} title="Trancar agora">
            🔒
          </button>
        )}
        <button className="palette-trigger" onClick={onOpenPalette} title="Busca rápida (Ctrl/Cmd+K)">
          🔍
        </button>
        <button className="settings-trigger" onClick={onOpenSettings} title="Configurações">
          ⚙️
        </button>
        <button className="theme-toggle" onClick={onThemeToggle} title={`Tema: ${THEME_LABEL[theme]} (clique para trocar)`}>
          {THEME_ICON[theme]}
        </button>
      </div>
    </aside>
  )
}
