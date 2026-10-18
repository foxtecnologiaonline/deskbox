interface OnboardingProps {
  onDismiss: () => void
}

export default function Onboarding({ onDismiss }: OnboardingProps): JSX.Element {
  return (
    <div className="onboarding-card">
      <h3>Bem-vindo ao Deskbox 👋</h3>
      <ul>
        <li>
          <strong>+</strong> na sidebar adiciona um serviço (WhatsApp, Gmail, Slack…)
        </li>
        <li>
          Agrupe serviços em <strong>workspaces</strong> pelos ícones no topo da sidebar — arraste um serviço pra lá
          pra movê-lo
        </li>
        <li>
          <strong>Ctrl/Cmd+K</strong> abre a busca rápida pra qualquer ação
        </li>
      </ul>
      <button className="primary-button" onClick={onDismiss}>
        Entendi
      </button>
    </div>
  )
}
