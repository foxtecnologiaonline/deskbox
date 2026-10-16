import { useState } from 'react'

interface NewWorkspaceModalProps {
  onClose: () => void
  onCreate: (name: string) => void
}

export default function NewWorkspaceModal({ onClose, onCreate }: NewWorkspaceModalProps): JSX.Element {
  const [name, setName] = useState('')

  function submit(e: React.FormEvent): void {
    e.preventDefault()
    if (!name.trim()) return
    onCreate(name.trim())
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Novo workspace</h2>
          <button className="modal-close" onClick={onClose}>
            ×
          </button>
        </header>
        <form className="custom-form" onSubmit={submit}>
          <label>
            Nome
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex.: Trabalho, Pessoal, Cliente X"
            />
          </label>
          <div className="custom-form-actions">
            <span />
            <button type="submit" className="primary-button">
              Criar
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
