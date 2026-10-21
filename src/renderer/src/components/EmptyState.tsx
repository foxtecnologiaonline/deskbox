import type { CatalogEntry } from '@shared/types'
import { faviconUrl } from '@shared/favicon'

const QUICK_ADD_IDS = ['whatsapp', 'gmail', 'slack', 'telegram', 'claude', 'notion']

interface EmptyStateProps {
  catalog: CatalogEntry[]
  onAddClick: () => void
  onQuickAdd: (catalogId: string) => void
}

export default function EmptyState({ catalog, onAddClick, onQuickAdd }: EmptyStateProps): JSX.Element {
  const quickEntries = QUICK_ADD_IDS.map((id) => catalog.find((entry) => entry.id === id)).filter(
    (entry): entry is CatalogEntry => Boolean(entry)
  )

  return (
    <div className="empty-state">
      <h1>Organize seus apps em um só lugar</h1>
      <p>Mensagem e produtividade, tudo numa janela só.</p>
      {quickEntries.length > 0 && (
        <div className="quick-add-row">
          {quickEntries.map((entry) => (
            <button key={entry.id} className="quick-add-chip" onClick={() => onQuickAdd(entry.id)} title={entry.name}>
              <img src={faviconUrl(entry.domain)} alt="" loading="lazy" />
              <span>{entry.name}</span>
            </button>
          ))}
        </div>
      )}
      <button className="primary-button" onClick={onAddClick}>
        + Ver catálogo completo
      </button>
    </div>
  )
}
