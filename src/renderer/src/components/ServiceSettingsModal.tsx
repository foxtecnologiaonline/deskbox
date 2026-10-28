import { useState } from 'react'
import type { ServiceInstance } from '@shared/types'
import { showToast } from '../toast'

const MAX_CODE = 200_000

interface ServiceSettingsModalProps {
  service: ServiceInstance
  onClose: () => void
}

export default function ServiceSettingsModal({ service, onClose }: ServiceSettingsModalProps): JSX.Element {
  const [proxyRules, setProxyRules] = useState(service.proxy?.rules ?? '')
  const [css, setCss] = useState(service.customCss)
  const [js, setJs] = useState(service.customJs)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (css.length > MAX_CODE || js.length > MAX_CODE) {
      setError('CSS e JS aceitam até 200.000 caracteres cada.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const rules = proxyRules.trim()
      await window.deskbox.setServiceSettings({
        instanceId: service.instanceId,
        proxy: rules ? { rules } : null,
        customCss: css,
        customJs: js
      })
      showToast(`Configurações de "${service.name}" salvas.`)
      onClose()
    } catch {
      setError('Não foi possível salvar.')
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal service-settings-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Configurar {service.name}</h2>
          <button className="modal-close" onClick={onClose}>
            ×
          </button>
        </header>

        <form className="custom-form" onSubmit={handleSave}>
          {service.jsPendingApproval && (
            <p className="settings-warning">
              Este serviço tem um JS personalizado que veio de outro dispositivo ou de um arquivo importado e ainda
              não rodou aqui. Revise o código abaixo — salvar aprova e executa.
            </p>
          )}

          <label>
            Proxy só deste serviço
            <input
              value={proxyRules}
              onChange={(e) => setProxyRules(e.target.value)}
              placeholder="Vazio = usa o proxy global · ex.: http=proxy:8080;https=proxy:8080 · direct:// ignora o global"
            />
          </label>

          <label>
            CSS personalizado
            <textarea
              className="code-input"
              value={css}
              onChange={(e) => setCss(e.target.value)}
              spellCheck={false}
              placeholder={'/* injetado em toda página deste serviço */\n.ads { display: none !important; }'}
            />
          </label>

          <label>
            JavaScript personalizado
            <textarea
              className="code-input"
              value={js}
              onChange={(e) => setJs(e.target.value)}
              spellCheck={false}
              placeholder={'// roda a cada carregamento de página deste serviço\ndocument.title = "Trabalho — " + document.title'}
            />
          </label>
          <p className="settings-hint">
            O JS roda dentro da página, com acesso à sessão em que você está logado. Cole apenas código em que você
            confia. Mudanças de CSS valem na hora; proxy e JS recarregam o serviço.
          </p>

          {error && <p className="settings-error">{error}</p>}
          <div className="custom-form-actions">
            <button type="button" className="link-button" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className="primary-button" disabled={saving}>
              Salvar
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
