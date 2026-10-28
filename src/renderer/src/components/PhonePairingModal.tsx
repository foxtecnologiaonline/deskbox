import { useEffect, useMemo, useState } from 'react'
import qrcode from 'qrcode-generator'
import type { PairingInfo } from '@shared/types'

interface PhonePairingModalProps {
  onClose: () => void
}

function qrDataUrl(text: string): string {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  return qr.createDataURL(6, 12)
}

export default function PhonePairingModal({ onClose }: PhonePairingModalProps): JSX.Element {
  const [info, setInfo] = useState<PairingInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [paired, setPaired] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    window.deskbox
      .startPhonePairing()
      .then((next) => !cancelled && setInfo(next))
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
  const secondsLeft = info ? Math.max(0, Math.round((info.expiresAt - now) / 1000)) : 0
  const expired = Boolean(info) && secondsLeft === 0

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal phone-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Adicionar celular Android</h2>
          <button className="modal-close" onClick={onClose}>
            ×
          </button>
        </header>

        {paired && <p className="settings-ok">Celular "{paired}" pareado! Abrindo…</p>}
        {error && <p className="settings-error">{error}</p>}

        {info && !paired && (
          <>
            <ol className="phone-steps">
              <li>
                Instale o app <strong>Deskbox Phone</strong> no celular (APK em <code>android/</code> / releases) e
                conecte-o na <strong>mesma rede Wi-Fi</strong> deste computador.
              </li>
              <li>No app, toque em escanear e aponte para o QR abaixo — ou digite os dados manualmente.</li>
              <li>Ative o serviço de acessibilidade do Deskbox no celular para poder controlar (sem ele, só espelha).</li>
            </ol>

            <div className="phone-pairing">
              {qr && <img className={`phone-qr ${expired ? 'expired' : ''}`} src={qr} alt="QR de pareamento" />}
              <dl className="phone-details">
                <dt>Código</dt>
                <dd className="phone-code">{info.code}</dd>
                <dt>Endereço</dt>
                <dd>{info.hosts.length ? info.hosts.map((h) => `${h}:${info.port}`).join(' · ') : `127.0.0.1:${info.port}`}</dd>
                <dt>Validade</dt>
                <dd>{expired ? 'Expirado' : `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`}</dd>
              </dl>
            </div>
            {expired && (
              <button className="primary-button" onClick={() => setAttempt((n) => n + 1)}>
                Gerar novo código
              </button>
            )}
            <p className="settings-hint">
              Tudo acontece na sua rede local — nada passa por servidores externos. Use apenas em redes{' '}
              <strong>confiáveis</strong> (casa/escritório): a sinalização na LAN ainda não usa TLS, então evite Wi-Fi
              público. Se o Windows perguntar, permita o Deskbox em redes <strong>privadas</strong> no firewall.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
