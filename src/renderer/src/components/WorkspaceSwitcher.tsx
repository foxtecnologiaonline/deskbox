import type { Workspace } from '@shared/types'
import { workspaceColor } from '@shared/workspaceColor'

interface WorkspaceSwitcherProps {
  workspaces: Workspace[]
  activeWorkspaceId: string
  draggingServiceId: string | null
  onSelect: (workspaceId: string) => void
  onAddClick: () => void
  onRemove: (workspaceId: string) => void
  onDropService: (instanceId: string, workspaceId: string) => void
}

function initials(name: string): string {
  return name.trim().slice(0, 2).toUpperCase() || '??'
}

export default function WorkspaceSwitcher({
  workspaces,
  activeWorkspaceId,
  draggingServiceId,
  onSelect,
  onAddClick,
  onRemove,
  onDropService
}: WorkspaceSwitcherProps): JSX.Element {
  return (
    <div className="workspace-switcher">
      {workspaces.map((workspace) => (
        <div
          key={workspace.id}
          className={`workspace-pill-wrap ${workspace.id === activeWorkspaceId ? 'active' : ''} ${
            draggingServiceId && workspace.id !== activeWorkspaceId ? 'drop-target' : ''
          }`}
          title={draggingServiceId ? `Mover para "${workspace.name}"` : workspace.name}
          onDragOver={(e) => {
            if (draggingServiceId) e.preventDefault()
          }}
          onDrop={() => {
            if (draggingServiceId) onDropService(draggingServiceId, workspace.id)
          }}
        >
          <button
            className="workspace-pill"
            style={{ backgroundColor: workspaceColor(workspace.id) }}
            onClick={() => onSelect(workspace.id)}
          >
            {initials(workspace.name)}
          </button>
          {workspaces.length > 1 && (
            <button
              className="remove-workspace"
              title="Remover workspace"
              onClick={(e) => {
                e.stopPropagation()
                if (window.confirm(`Remover o workspace "${workspace.name}" e todos os seus serviços?`)) {
                  onRemove(workspace.id)
                }
              }}
            >
              ×
            </button>
          )}
        </div>
      ))}
      <button className="add-workspace" onClick={onAddClick} title="Novo workspace">
        +
      </button>
    </div>
  )
}
