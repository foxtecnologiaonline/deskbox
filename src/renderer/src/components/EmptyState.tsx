interface EmptyStateProps {
  onAddClick: () => void
}

export default function EmptyState({ onAddClick }: EmptyStateProps): JSX.Element {
  return (
    <div className="empty-state">
      <h1>Bem-vindo ao Deskbox</h1>
      <p>Organize seus apps de mensagem e produtividade em um só lugar.</p>
      <button className="primary-button" onClick={onAddClick}>
        + Adicionar primeiro serviço
      </button>
    </div>
  )
}
