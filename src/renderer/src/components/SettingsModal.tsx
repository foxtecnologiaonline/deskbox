import { useEffect, useState } from 'react'
import type { ProxyConfig, SidebarDensity, SyncView, UpdateStatus } from '@shared/types'
import { showToast } from '../toast'

interface SettingsModalProps {
  hasPassword: boolean
  proxy: ProxyConfig | null
  hibernateAfterMinutes: number | null
  sidebarDensity: SidebarDensity
  notificationsEnabled: boolean
  minimizeToTray: boolean
  launchAtLogin: boolean
  startMinimized: boolean
  autoUpdate: boolean
  sync: SyncView | null
  pendingJsCount: number
  onClose: () => void
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

const UPDATE_LABEL: Record<UpdateStatus['state'], string> = {
  idle: 'Nenhuma verificação feita ainda.',
  checking: 'Verificando…',
  available: 'Nova versão disponível.',
  downloading: 'Baixando atualização…',
  downloaded: 'Atualização pronta para instalar.',
  'not-available': 'Você está na versão mais recente.',
  error: 'Não foi possível verificar.',
  unsupported: 'Indisponível neste modo.'
}

const HIBERNATE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '5', label: '5 minutos' },
  { value: '10', label: '10 minutos' },
  { value: '30', label: '30 minutos' },
  { value: 'never', label: 'Nunca hibernar' }
]

const DENSITY_OPTIONS: Array<{ value: SidebarDensity; label: string }> = [
  { value: 'comfortable', label: 'Confortável' },
  { value: 'compact', label: 'Compacta' }
]

export default function SettingsModal({
  hasPassword,
  proxy,
  hibernateAfterMinutes,
  sidebarDensity,
  notificationsEnabled,
  minimizeToTray,
  launchAtLogin,
  startMinimized,
  autoUpdate,
  sync,
  pendingJsCount,
  onClose
}: SettingsModalProps): JSX.Element {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordError, setPasswordError] = useState<string | null>(null)

  const [proxyRules, setProxyRules] = useState(proxy?.rules ?? '')
  const [busy, setBusy] = useState(false)

  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    window.deskbox.getUpdateStatus().then(setUpdate)
    return window.deskbox.onUpdateStatus(setUpdate)
  }, [])

  const [syncFolder, setSyncFolder] = useState('')
  const [syncPassphrase, setSyncPassphrase] = useState('')
  const [syncError, setSyncError] = useState<string | null>(null)
  const [syncConflict, setSyncConflict] = useState<{ updatedAt: number; services: number; workspaces: number } | null>(null)
  const [syncBusy, setSyncBusy] = useState(false)
  const [newPassphrase, setNewPassphrase] = useState('')

  async function handleChooseFolder(): Promise<void> {
    const folder = await window.deskbox.chooseSyncFolder()
    if (folder) setSyncFolder(folder)
  }

  async function handleEnableSync(resolve?: 'remote' | 'local'): Promise<void> {
    setSyncBusy(true)
    setSyncError(null)
    const result = await window.deskbox.enableSync({ folder: syncFolder, passphrase: syncPassphrase || undefined }, resolve)
    setSyncBusy(false)
    if (result.ok) {
      setSyncConflict(null)
      setSyncPassphrase('')
      showToast('Sincronização ativada.')
    } else if (result.conflict) {
      setSyncConflict(result.conflict)
    } else {
      setSyncError(result.error ?? 'Não foi possível ativar.')
    }
  }

  async function handleProvidePassphrase(): Promise<void> {
    setSyncBusy(true)
    const result = await window.deskbox.provideSyncPassphrase(newPassphrase)
    setSyncBusy(false)
    if (result.ok) {
      setNewPassphrase('')
      showToast('Sincronização retomada.')
    }
  }

  async function handleDisableSync(): Promise<void> {
    if (!window.confirm('Desativar a sincronização neste dispositivo? O arquivo na pasta não é apagado.')) return
    await window.deskbox.disableSync()
    setSyncFolder('')
    showToast('Sincronização desativada.')
  }

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

  async function handleDensityChange(e: React.ChangeEvent<HTMLSelectElement>): Promise<void> {
    await window.deskbox.setSidebarDensity(e.target.value as SidebarDensity)
    showToast('Densidade da sidebar atualizada.')
  }

  async function handleNotificationsChange(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    await window.deskbox.setNotificationsEnabled(e.target.checked)
  }

  async function handleMinimizeToTrayChange(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    await window.deskbox.setMinimizeToTray(e.target.checked)
  }

  async function handleLaunchAtLoginChange(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    await window.deskbox.setLaunchAtLogin(e.target.checked)
  }

  async function handleStartMinimizedChange(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    await window.deskbox.setStartMinimized(e.target.checked)
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
          <h3>Aparência</h3>
          <label className="settings-select-label">
            Densidade da sidebar
            <select value={sidebarDensity} onChange={handleDensityChange}>
              {DENSITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </section>

        <section className="settings-section">
          <h3>Notificações</h3>
          <label className="settings-checkbox-label">
            <input type="checkbox" checked={notificationsEnabled} onChange={handleNotificationsChange} />
            Notificar mensagens novas quando o Deskbox estiver em segundo plano
          </label>
        </section>

        <section className="settings-section">
          <h3>Inicialização e bandeja</h3>
          <label className="settings-checkbox-label">
            <input type="checkbox" checked={minimizeToTray} onChange={handleMinimizeToTrayChange} />
            Minimizar pra bandeja do sistema ao fechar a janela (em vez de encerrar)
          </label>
          <label className="settings-checkbox-label">
            <input type="checkbox" checked={launchAtLogin} onChange={handleLaunchAtLoginChange} />
            Iniciar o Deskbox junto com o sistema
          </label>
          <label className="settings-checkbox-label">
            <input type="checkbox" checked={startMinimized} onChange={handleStartMinimizedChange} />
            Iniciar minimizado (só na bandeja)
          </label>
        </section>

        <section className="settings-section">
          <h3>Atualizações</h3>
          <p className="settings-hint">
            Versão atual: <strong>{update?.currentVersion ?? '…'}</strong>
            {update?.portable ? ' (portátil — não se atualiza sozinha)' : ''}
          </p>
          <label className="settings-checkbox-label">
            <input
              type="checkbox"
              checked={autoUpdate}
              onChange={(e) => window.deskbox.setAutoUpdate(e.target.checked)}
            />
            Verificar atualizações automaticamente
          </label>
          {update && (
            <p className={update.state === 'error' ? 'settings-error' : 'settings-hint'}>
              {update.state === 'error' || update.state === 'unsupported' ? update.error : UPDATE_LABEL[update.state]}
              {update.version && (update.state === 'available' || update.state === 'downloading' || update.state === 'downloaded')
                ? ` v${update.version}`
                : ''}
              {update.state === 'downloading' && update.progress !== undefined ? ` ${update.progress}%` : ''}
            </p>
          )}
          <div className="custom-form-actions">
            {update?.state === 'available' && update.portable ? (
              <button type="button" className="link-button" onClick={() => window.deskbox.openReleases()}>
                Abrir página da versão
              </button>
            ) : (
              <span />
            )}
            {update?.state === 'downloaded' ? (
              <button type="button" className="primary-button" onClick={() => window.deskbox.installUpdate()}>
                Reiniciar e instalar
              </button>
            ) : (
              <button
                type="button"
                className="link-button"
                disabled={update?.state === 'checking' || update?.state === 'downloading'}
                onClick={() => window.deskbox.checkForUpdates()}
              >
                Verificar agora
              </button>
            )}
          </div>
        </section>

        <section className="settings-section">
          <h3>Sincronização entre dispositivos</h3>
          {!sync ? (
            <>
              <p className="settings-hint">
                Mantém serviços, workspaces, tema e CSS/JS iguais em vários computadores usando uma pasta que você já
                sincroniza (Dropbox, OneDrive, Google Drive, Syncthing…). Sem conta e sem servidor nosso. Logins e
                proxies <strong>não</strong> sincronizam — cada dispositivo mantém os seus.
              </p>
              <div className="custom-form">
                <div className="sync-folder-row">
                  <input value={syncFolder} readOnly placeholder="Nenhuma pasta escolhida" />
                  <button type="button" className="link-button" onClick={handleChooseFolder}>
                    Escolher pasta…
                  </button>
                </div>
                <label>
                  Senha para criptografar o arquivo (recomendado)
                  <input
                    type="password"
                    value={syncPassphrase}
                    onChange={(e) => setSyncPassphrase(e.target.value)}
                    placeholder="Use a mesma senha nos outros dispositivos"
                  />
                </label>
                {syncError && <p className="settings-error">{syncError}</p>}
                {syncError && syncFolder && (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => {
                      if (window.confirm('Substituir o arquivo de sincronização da pasta pela configuração DESTE dispositivo?')) {
                        void handleEnableSync('local')
                      }
                    }}
                  >
                    Substituir o arquivo da pasta por esta configuração
                  </button>
                )}
                {syncConflict && (
                  <div className="settings-conflict">
                    <p>
                      Já existe uma configuração nesta pasta ({syncConflict.services} serviços, {syncConflict.workspaces}{' '}
                      workspaces, de {formatTime(syncConflict.updatedAt)}) diferente da deste dispositivo.
                    </p>
                    <div className="custom-form-actions">
                      <button type="button" className="link-button" onClick={() => setSyncConflict(null)}>
                        Cancelar
                      </button>
                      <button type="button" className="link-button" onClick={() => handleEnableSync('local')}>
                        Manter a deste dispositivo
                      </button>
                      <button type="button" className="primary-button" onClick={() => handleEnableSync('remote')}>
                        Usar a da pasta
                      </button>
                    </div>
                  </div>
                )}
                <div className="custom-form-actions">
                  <span />
                  <button
                    type="button"
                    className="primary-button"
                    disabled={!syncFolder || syncBusy}
                    onClick={() => handleEnableSync()}
                  >
                    Ativar sincronização
                  </button>
                </div>
              </div>
            </>
          ) : (
            <>
              <p className="settings-hint">
                Pasta: <code>{sync.folder}</code> · {sync.encrypted ? 'criptografado' : 'sem criptografia'}
              </p>
              <p className={sync.status === 'error' || sync.status === 'needs-passphrase' ? 'settings-error' : 'settings-hint'}>
                {sync.status === 'syncing'
                  ? 'Sincronizando…'
                  : sync.error ?? (sync.lastSyncAt ? `Sincronizado em ${formatTime(sync.lastSyncAt)}.` : 'Aguardando a primeira sincronização.')}
              </p>
              {(sync.status === 'needs-passphrase' || (sync.status === 'error' && sync.error?.includes('Senha'))) && (
                <div className="sync-folder-row">
                  <input
                    type="password"
                    value={newPassphrase}
                    onChange={(e) => setNewPassphrase(e.target.value)}
                    placeholder="Senha de sincronização"
                  />
                  <button type="button" className="link-button" disabled={syncBusy} onClick={handleProvidePassphrase}>
                    Informar senha
                  </button>
                </div>
              )}
              {pendingJsCount > 0 && (
                <p className="settings-warning">
                  {pendingJsCount} serviço(s) com JS personalizado vindo de outro dispositivo aguardando sua aprovação (clique
                  direito no ícone → Configurar).
                </p>
              )}
              <div className="custom-form-actions">
                <button type="button" className="link-button" onClick={handleDisableSync}>
                  Desativar
                </button>
                <button type="button" className="link-button" onClick={() => window.deskbox.syncNow()}>
                  Sincronizar agora
                </button>
              </div>
            </>
          )}
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
