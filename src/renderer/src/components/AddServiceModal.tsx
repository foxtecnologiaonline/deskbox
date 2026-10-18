import { useMemo, useState } from 'react'
import type { CatalogEntry } from '@shared/types'
import { faviconUrl } from '@shared/favicon'

interface AddServiceModalProps {
  catalog: CatalogEntry[]
  onClose: () => void
  onAddFromCatalog: (catalogId: string) => void
  onAddCustom: (name: string, url: string) => void
}

export default function AddServiceModal({
  catalog,
  onClose,
  onAddFromCatalog,
  onAddCustom
}: AddServiceModalProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [customMode, setCustomMode] = useState(false)
  const [customName, setCustomName] = useState('')
  const [customUrl, setCustomUrl] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return catalog
    return catalog.filter(
      (entry) => entry.name.toLowerCase().includes(q) || entry.category.toLowerCase().includes(q)
    )
  }, [catalog, query])

  function submitCustom(e: React.FormEvent): void {
    e.preventDefault()
    if (!customName.trim() || !customUrl.trim()) return
    let url = customUrl.trim()
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`
    onAddCustom(customName.trim(), url)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Adicionar serviço</h2>
          <button className="modal-close" onClick={onClose}>
            ×
          </button>
        </header>

        {!customMode && (
          <>
            <input
              autoFocus
              className="modal-search"
              placeholder="Buscar serviço…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="catalog-grid">
              {filtered.map((entry) => (
                <button key={entry.id} className="catalog-item" onClick={() => onAddFromCatalog(entry.id)}>
                  <img src={faviconUrl(entry.domain)} alt={entry.name} loading="lazy" />
                  <span>{entry.name}</span>
                </button>
              ))}
              {filtered.length === 0 && <p className="catalog-empty">Nenhum serviço encontrado.</p>}
            </div>
            <button className="link-button" onClick={() => setCustomMode(true)}>
              + Adicionar site personalizado
            </button>
          </>
        )}

        {customMode && (
          <form className="custom-form" onSubmit={submitCustom}>
            <label>
              Nome
              <input value={customName} onChange={(e) => setCustomName(e.target.value)} placeholder="Meu site" />
            </label>
            <label>
              URL
              <input
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                placeholder="https://exemplo.com"
              />
            </label>
            <div className="custom-form-actions">
              <button type="button" className="link-button" onClick={() => setCustomMode(false)}>
                Voltar ao catálogo
              </button>
              <button type="submit" className="primary-button">
                Adicionar
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
