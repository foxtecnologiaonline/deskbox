import type { Workspace } from '@shared/types'

interface WorkspaceSwitcherProps {
  workspaces: Workspace[]
  activeWorkspaceId: string
  onSelect: (workspaceId: string) => void
  onAddClick: () => void
  onRemove: (workspaceId: string) => void
}

function initials(name: string): string {
  return name.trim().slice(0, 2).toUpperCase() || '??'
}

export default function WorkspaceSwitcher({
  workspaces,
  activeWorkspaceId,
  onSelect,
  onAddClick,
  onRemove
}: WorkspaceSwitcherProps): JSX.Element {
  return (
    <div className="workspace-switcher">
      {workspaces.map((workspace) => (
        <div
          key={workspace.id}
          className={`workspace-pill-wrap ${workspace.id === activeWorkspaceId ? 'active' : ''}`}
          title={workspace.name}
        >
          <button className="workspace-pill" onClick={() => onSelect(workspace.id)}>
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
