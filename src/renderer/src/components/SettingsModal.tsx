import { useState } from 'react'
import type { ProxyConfig } from '@shared/types'
import { showToast } from '../toast'

interface SettingsModalProps {
  hasPassword: boolean
  proxy: ProxyConfig | null
  hibernateAfterMinutes: number | null
  onClose: () => void
}

const HIBERNATE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '5', label: '5 minutos' },
  { value: '10', label: '10 minutos' },
  { value: '30', label: '30 minutos' },
  { value: 'never', label: 'Nunca hibernar' }
]

export default function SettingsModal({
  hasPassword,
  proxy,
  hibernateAfterMinutes,
  onClose
}: SettingsModalProps): JSX.Element {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordError, setPasswordError] = useState<string | null>(null)

  const [proxyRules, setProxyRules] = useState(proxy?.rules ?? '')
  const [busy, setBusy] = useState(false)

  async function handleSetPassword(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setPasswordError(null)
    if (newPassword && newPassword !== confirmPassword) {
      setPasswordError('As senhas não coincidem.')
      return
    }
    const result = await window.deskbox.setPassword(newPassword || null, currentPassword || undefined)
    if (!result.ok) {
      setPasswordError(result.error ?? 'Não foi possível salvar.')
      return
    }
    showToast(newPassword ? 'Senha salva.' : 'Senha removida.')
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
  }

  async function handleSaveProxy(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const trimmed = proxyRules.trim()
    await window.deskbox.setProxy(trimmed ? { rules: trimmed } : null)
    showToast(trimmed ? 'Proxy aplicado.' : 'Proxy removido.')
  }

  async function handleHibernateChange(e: React.ChangeEvent<HTMLSelectElement>): Promise<void> {
    const minutes = e.target.value === 'never' ? null : Number(e.target.value)
    await window.deskbox.setHibernateAfterMinutes(minutes)
    showToast('Hibernação atualizada.')
  }

  async function handleExport(): Promise<void> {
    setBusy(true)
    const result = await window.deskbox.exportConfig()
    setBusy(false)
    if (result.ok) showToast('Configuração exportada.')
    else if (result.error && result.error !== 'Cancelado.') showToast(`Falha ao exportar: ${result.error}`)
  }

  async function handleImport(): Promise<void> {
    if (
      !window.confirm(
        'Importar substitui todos os serviços, workspaces, tema e proxy atuais pelos do arquivo. Os logins de cada serviço não vêm junto — você precisará entrar de novo. Continuar?'
      )
    ) {
      return
    }
    setBusy(true)
    const result = await window.deskbox.importConfig()
    setBusy(false)
    if (result.ok) showToast('Configuração importada.')
    else if (result.error && result.error !== 'Cancelado.') showToast(`Falha ao importar: ${result.error}`)
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
            {passwordError && <p className="settings-error">{passwordError}</p>}
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
            <div className="custom-form-actions">
              <span />
              <button type="submit" className="primary-button">
                Salvar proxy
              </button>
            </div>
          </form>
        </section>

        <section className="settings-section">
          <h3>Hibernação automática</h3>
          <label className="settings-select-label">
            Descarregar serviços inativos da memória após
            <select value={hibernateAfterMinutes ?? 'never'} onChange={handleHibernateChange}>
              {HIBERNATE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </section>

        <section className="settings-section">
          <h3>Backup</h3>
          <p className="settings-hint">
            Exporta/importa a lista de serviços, workspaces, tema e proxy. Não inclui a senha mestre nem os logins de
            cada serviço (isso fica salvo separadamente, fora deste arquivo).
          </p>
          <div className="custom-form-actions">
            <button type="button" className="link-button" onClick={handleImport} disabled={busy}>
              Importar configuração…
            </button>
            <button type="button" className="primary-button" onClick={handleExport} disabled={busy}>
              Exportar configuração
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}
