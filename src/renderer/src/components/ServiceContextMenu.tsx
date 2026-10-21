import { useEffect, useRef } from 'react'
import type { ServiceInstance } from '@shared/types'

interface ServiceContextMenuProps {
  service: ServiceInstance
  x: number
  y: number
  onClose: () => void
  onTogglePinned: () => void
  onDuplicate: () => void
  onRemove: () => void
}

export default function ServiceContextMenu({
  service,
  x,
  y,
  onClose,
  onTogglePinned,
  onDuplicate,
  onRemove
}: ServiceContextMenuProps): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)

  // Fecha ao clicar/clicar-com-botão-direito fora do menu. Sem backdrop
  // cobrindo a tela: um listener de captura que só observa (não bloqueia o
  // ponteiro) deixa o clique chegar normalmente no elemento de baixo — ex.:
  // botão direito num outro ícone de serviço troca o menu pra ele num clique
  // só, em vez de precisar fechar e abrir de novo.
  useEffect(() => {
    function handleOutside(event: MouseEvent): void {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose()
      }
    }
    window.addEventListener('mousedown', handleOutside, true)
    window.addEventListener('contextmenu', handleOutside, true)
    return () => {
      window.removeEventListener('mousedown', handleOutside, true)
      window.removeEventListener('contextmenu', handleOutside, true)
    }
  }, [onClose])

  return (
    <div ref={menuRef} className="context-menu" style={{ top: y, left: x }}>
      <button
        onClick={() => {
          onTogglePinned()
          onClose()
        }}
      >
        {service.pinned ? '📌 Desafixar' : '📌 Fixar (nunca hibernar)'}
      </button>
      <button
        onClick={() => {
          onDuplicate()
          onClose()
        }}
      >
        ➕ Adicionar outra conta
      </button>
      <button
        className="context-menu-danger"
        onClick={() => {
          onRemove()
          onClose()
        }}
      >
        🗑 Remover
      </button>
    </div>
  )
}
