import { useState } from 'react'
import type { ProxyConfig } from '@shared/types'

interface SettingsModalProps {
  hasPassword: boolean
  proxy: ProxyConfig | null
  onClose: () => void
}

export default function SettingsModal({ hasPassword, proxy, onClose }: SettingsModalProps): JSX.Element {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordMessage, setPasswordMessage] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  const [proxyRules, setProxyRules] = useState(proxy?.rules ?? '')
  const [proxyMessage, setProxyMessage] = useState<string | null>(null)

  async function handleSetPassword(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setPasswordMessage(null)
    if (newPassword && newPassword !== confirmPassword) {
      setPasswordMessage({ type: 'error', text: 'As senhas não coincidem.' })
      return
    }
    const result = await window.deskbox.setPassword(newPassword || null, currentPassword || undefined)
    if (!result.ok) {
      setPasswordMessage({ type: 'error', text: result.error ?? 'Não foi possível salvar.' })
      return
    }
    setPasswordMessage({ type: 'ok', text: newPassword ? 'Senha salva.' : 'Senha removida.' })
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
  }

  async function handleSaveProxy(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const trimmed = proxyRules.trim()
    await window.deskbox.setProxy(trimmed ? { rules: trimmed } : null)
    setProxyMessage(trimmed ? 'Proxy aplicado.' : 'Proxy removido.')
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Configurações</h2>
          <button className="modal-close" onClick={onClose}>
            ×
          </button>
        </header>

        <section className="settings-section">
          <h3>Proteção por senha</h3>
          <form className="custom-form" onSubmit={handleSetPassword}>
            {hasPassword && (
              <label>
                Senha atual
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder="Necessária pra trocar ou remover"
                />
              </label>
            )}
            <label>
              {hasPassword ? 'Nova senha (deixe em branco pra remover a proteção)' : 'Nova senha'}
              <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
            </label>
            {newPassword && (
              <label>
                Confirmar nova senha
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
              </label>
            )}
            {passwordMessage && (
              <p className={passwordMessage.type === 'error' ? 'settings-error' : 'settings-ok'}>
                {passwordMessage.text}
              </p>
            )}
            <div className="custom-form-actions">
              {hasPassword ? (
                <button type="button" className="link-button" onClick={() => window.deskbox.lockNow()}>
                  Trancar agora
                </button>
              ) : (
                <span />
              )}
              <button type="submit" className="primary-button">
                {hasPassword ? 'Salvar' : 'Definir senha'}
              </button>
            </div>
          </form>
        </section>

        <section className="settings-section">
          <h3>Proxy</h3>
          <form className="custom-form" onSubmit={handleSaveProxy}>
            <label>
              Regras de proxy (global, vale pra todos os serviços)
              <input
                value={proxyRules}
                onChange={(e) => setProxyRules(e.target.value)}
                placeholder="http=proxy.empresa.com:8080;https=proxy.empresa.com:8080"
              />
            </label>
            {proxyMessage && <p className="settings-ok">{proxyMessage}</p>}
            <div className="custom-form-actions">
              <span />
              <button type="submit" className="primary-button">
                Salvar proxy
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  )
}
