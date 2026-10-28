import { useEffect, useRef } from 'react'
import type { ServiceInstance } from '@shared/types'
import { PHONE_CATALOG_ID } from '@shared/phone'

// Precisam bater com a largura/altura reais do CSS (.context-menu) — sem
// clamping, o menu aberto perto da borda inferior da janela (sidebar com
// muitos serviços) fica cortado por `overflow: hidden` do .app-shell e os
// últimos botões ficam inacessíveis.
const MENU_WIDTH = 200
const MENU_HEIGHT = 160
const MARGIN = 8

function clamp(value: number, max: number): number {
  return Math.max(MARGIN, Math.min(value, max))
}

interface ServiceContextMenuProps {
  service: ServiceInstance
  x: number
  y: number
  onClose: () => void
  onTogglePinned: () => void
  onConfigure: () => void
  onDuplicate: () => void
  onRemove: () => void
}

export default function ServiceContextMenu({
  service,
  x,
  y,
  onClose,
  onTogglePinned,
  onConfigure,
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

  const isPhone = service.catalogId === PHONE_CATALOG_ID
  const left = clamp(x, window.innerWidth - MENU_WIDTH - MARGIN)
  const top = clamp(y, window.innerHeight - MENU_HEIGHT - MARGIN)

  return (
    <div ref={menuRef} className="context-menu" style={{ top, left }}>
      <button
        onClick={() => {
          onTogglePinned()
          onClose()
        }}
      >
        {service.pinned ? '📌 Desafixar' : '📌 Fixar (nunca hibernar)'}
      </button>
      {!isPhone && (
        <button
          onClick={() => {
            onConfigure()
            onClose()
          }}
        >
          ⚙ Configurar (CSS, JS, proxy)…
        </button>
      )}
      {!isPhone && (
        <button
          onClick={() => {
            onDuplicate()
            onClose()
          }}
        >
          ➕ Adicionar outra conta
        </button>
      )}
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
