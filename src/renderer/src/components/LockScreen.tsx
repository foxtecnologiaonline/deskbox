import { useState } from 'react'

export default function LockScreen(): JSX.Element {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setChecking(true)
    setError(null)
    const ok = await window.deskbox.unlock(password)
    setChecking(false)
    if (!ok) {
      setError('Senha incorreta.')
      setPassword('')
      return
    }
    setPassword('')
  }

  return (
    <div className="lock-screen">
      <form className="lock-card" onSubmit={submit}>
        <div className="lock-icon">🔒</div>
        <h1>Deskbox trancado</h1>
        <input
          autoFocus
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Senha"
          className="lock-input"
        />
        {error && <p className="lock-error">{error}</p>}
        <button type="submit" className="primary-button" disabled={checking || !password}>
          {checking ? 'Verificando…' : 'Destravar'}
        </button>
        <p className="lock-hint">
          Esqueceu a senha? Feche o app e apague o arquivo de configuração do Deskbox — isso reseta tudo, inclusive
          os serviços adicionados.
        </p>
      </form>
    </div>
  )
}
