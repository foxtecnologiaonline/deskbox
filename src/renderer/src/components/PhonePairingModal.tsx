import { useEffect, useMemo, useState } from 'react'
import qrcode from 'qrcode-generator'
import type { PairingInfo } from '@shared/types'

interface PhonePairingModalProps {
  onClose: () => void
}

/** Asset fixo anexado a cada release pelo workflow Release (`/latest/download/` sempre aponta pra versão mais nova). */
const APK_URL = 'https://github.com/foxtecnologiaonline/deskbox/releases/latest/download/Deskbox-Phone.apk'
/** Sem o celular conectar nesse tempo, sugerimos a conexão reversa (firewall costuma ser o motivo). */
const DIRECT_HINT_AFTER_MS = 30_000

function qrDataUrl(text: string, cell = 6): string {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  return qr.createDataURL(cell, 12)
}

type Tab = 'qr' | 'link'

export default function PhonePairingModal({ onClose }: PhonePairingModalProps): JSX.Element {
  const [tab, setTab] = useState<Tab>('qr')
  const [info, setInfo] = useState<PairingInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [paired, setPaired] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [attempt, setAttempt] = useState(0)
  const [startedAt, setStartedAt] = useState(Date.now())
  const [showApkQr, setShowApkQr] = useState(false)
  const [address, setAddress] = useState('')
  const [linkCode, setLinkCode] = useState('')
  const [linking, setLinking] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    window.deskbox
      .startPhonePairing()
      .then((next) => {
        if (cancelled) return
        setInfo(next)
        setStartedAt(Date.now())
      })
      .catch((e: Error) => !cancelled && setError(e.message || 'Não foi possível iniciar o pareamento.'))
    return () => {
      cancelled = true
      void window.deskbox.cancelPhonePairing()
    }
  }, [attempt])

  useEffect(() => {
    return window.deskbox.onPhoneChanged((event) => {
      if (event.type === 'paired') {
        setPaired(event.name)
        setTimeout(onClose, 1500)
      }
    })
  }, [onClose])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const qr = useMemo(() => (info ? qrDataUrl(info.uri) : null), [info])
  const apkQr = useMemo(() => (showApkQr ? qrDataUrl(APK_URL, 4) : null), [showApkQr])
  const secondsLeft = info ? Math.max(0, Math.round((info.expiresAt - now) / 1000)) : 0
  const expired = Boolean(info) && secondsLeft === 0
  const slowDirect = Boolean(info) && !expired && now - startedAt > DIRECT_HINT_AFTER_MS

  async function handleLink(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setLinkError(null)
    setLinking(true)
    const result = await window.deskbox.linkPhone(address, linkCode)
    setLinking(false)
    if (!result.ok) setLinkError(result.error)
    // Sucesso: o evento "paired" fecha o modal (mesmo caminho do QR).
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal phone-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Adicionar celular Android</h2>
          <button className="modal-close" onClick={onClose}>
            ×
          </button>
        </header>

        {paired ? (
          <p className="settings-ok">Celular "{paired}" pareado! Abrindo…</p>
        ) : (
          <>
            <div className="phone-install">
              <p>
                <strong>Precisa do app Deskbox Celular</strong> no Android (8 ou mais novo) — o Android só deixa outro
                aparelho ver e tocar na tela por um app autorizado por você.
              </p>
              <div className="phone-install-actions">
                <button type="button" className="link-button" onClick={() => setShowApkQr((v) => !v)}>
                  {showApkQr ? 'Ocultar QR de download' : 'QR para baixar o app'}
                </button>
                <button type="button" className="link-button" onClick={() => void window.deskbox.openReleases()}>
                  Página de downloads
                </button>
              </div>
              {apkQr && (
                <div className="phone-apk">
                  <img className="phone-qr small" src={apkQr} alt="QR para baixar o app Deskbox Celular" />
                  <p className="settings-hint">
                    Aponte a câmera do celular, baixe <code>Deskbox-Phone.apk</code> e abra. O Android pede para permitir
                    "instalar apps desconhecidos" — permita só para o navegador/arquivos que você usou.
                  </p>
                </div>
              )}
            </div>

            <div className="phone-tabs" role="tablist">
              <button role="tab" aria-selected={tab === 'qr'} className={tab === 'qr' ? 'active' : ''} onClick={() => setTab('qr')}>
                Escanear QR <span>(recomendado)</span>
              </button>
              <button role="tab" aria-selected={tab === 'link'} className={tab === 'link' ? 'active' : ''} onClick={() => setTab('link')}>
                Conectar pelo celular <span>(portátil / sem admin)</span>
              </button>
            </div>

            {tab === 'qr' && (
              <>
                {error && <p className="settings-error">{error} Use "Conectar pelo celular".</p>}
                {info && (
                  <>
                    <ol className="phone-steps">
                      <li>
                        Celular e computador na <strong>mesma rede Wi-Fi</strong>.
                      </li>
                      <li>
                        No app, toque em <strong>Escanear QR do Deskbox</strong> e aponte para o código abaixo — depois em{' '}
                        <strong>Iniciar compartilhamento</strong> e escolha <strong>tela inteira</strong>.
                      </li>
                      <li>Para controlar (não só ver), ative a acessibilidade do Deskbox no app.</li>
                    </ol>

                    <div className="phone-pairing">
                      {qr && <img className={`phone-qr ${expired ? 'expired' : ''}`} src={qr} alt="QR de pareamento" />}
                      <dl className="phone-details">
                        <dt>Código</dt>
                        <dd className="phone-code">{info.code}</dd>
                        <dt>Endereço</dt>
                        <dd>{info.hosts.length ? info.hosts.slice(0, 3).map((h) => `${h}:${info.port}`).join(' · ') : `127.0.0.1:${info.port}`}</dd>
                        <dt>Validade</dt>
                        <dd>{expired ? 'Expirado' : `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`}</dd>
                      </dl>
                    </div>
                    {expired && (
                      <button className="primary-button" onClick={() => setAttempt((n) => n + 1)}>
                        Gerar novo código
                      </button>
                    )}
                    <p className={slowDirect ? 'settings-warning' : 'settings-hint'}>
                      {slowDirect ? 'O celular ainda não conectou? ' : ''}Se o Windows pedir, permita o Deskbox no
                      firewall. Sem permissão de administrador (Deskbox portátil) ou com a rede marcada como{' '}
                      <strong>Pública</strong>, o celular não consegue chegar ao computador — use{' '}
                      <button type="button" className="link-button inline" onClick={() => setTab('link')}>
                        Conectar pelo celular
                      </button>
                      .
                    </p>
                  </>
                )}
              </>
            )}

            {tab === 'link' && (
              <form className="phone-link" onSubmit={handleLink}>
                <ol className="phone-steps">
                  <li>
                    No app do celular, toque em <strong>Iniciar compartilhamento</strong> (o campo de IP do computador pode
                    ficar vazio) e escolha <strong>tela inteira</strong>.
                  </li>
                  <li>
                    O app mostra <strong>"Conectar pelo computador"</strong> com um endereço e um código. Digite aqui:
                  </li>
                </ol>
                <div className="phone-link-fields">
                  <label>
                    Endereço do celular
                    <input
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                      placeholder="192.168.0.23:47891"
                      autoFocus
                      spellCheck={false}
                    />
                  </label>
                  <label>
                    Código
                    <input
                      value={linkCode}
                      onChange={(e) => setLinkCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="000000"
                      inputMode="numeric"
                      className="phone-code-input"
                    />
                  </label>
                </div>
                {linkError && <p className="settings-error">{linkError}</p>}
                <button className="primary-button" type="submit" disabled={linking || !address.trim() || linkCode.length !== 6}>
                  {linking ? 'Conectando…' : 'Conectar'}
                </button>
                <p className="settings-hint">
                  Aqui é o Deskbox que conecta no celular, então funciona mesmo quando o firewall bloqueia conexões de
                  entrada no computador. Depois de pareado, ele reconecta sozinho sempre que você iniciar o compartilhamento
                  no celular.
                </p>
              </form>
            )}

            <p className="settings-hint">
              Tudo acontece na sua rede local — nada passa por servidores externos. Use em redes{' '}
              <strong>confiáveis</strong> (casa/escritório), não em Wi-Fi público.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
