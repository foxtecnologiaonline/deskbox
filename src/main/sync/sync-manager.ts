import { app, safeStorage } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, watch, writeFileSync, unlinkSync, type FSWatcher } from 'fs'
import { join } from 'path'
import type { DeskboxState, SyncResult, SyncSettings, SyncView } from '@shared/types'
import type { Store } from '../store'
import { decodeEnvelope, encodeEnvelope, peekEnvelope, type SyncEnvelope } from './codec'
import { toSyncPayload, type SyncPayload } from './payload'

const FILE_NAME = 'deskbox-sync.json'
const PUSH_DEBOUNCE_MS = 2000
const POLL_INTERVAL_MS = 60 * 1000
// Carimbo de um arquivo mais de 1 dia no futuro = relógio errado (ou arquivo hostil): não vence o last-writer-wins.
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000

type RemoteError = 'corrupt' | 'needs-passphrase' | 'bad-passphrase' | 'unsupported' | 'bad-clock' | 'downgrade'

export interface SyncHost {
  isLocked(): boolean
  applyRemote(payload: SyncPayload, remoteUpdatedAt: number): void
  /** Chamado quando o status muda, pra a UI refletir. */
  statusChanged(): void
}

export interface RemoteSummary {
  updatedAt: number
  services: number
  workspaces: number
}

export type EnableResult = SyncResult & { conflict?: RemoteSummary }

/**
 * Sincronização por arquivo numa pasta que o usuário já sincroniza por outro meio (Dropbox, OneDrive,
 * Google Drive, Syncthing, pasta de rede...). Sem backend nosso: nada de conta, nada de servidor.
 * Estratégia: last-writer-wins por `configUpdatedAt` (config inteira, não campo a campo).
 */
export class SyncManager {
  private store: Store
  private host: SyncHost
  private passphrase: string | null = null
  private status: SyncView['status'] = 'idle'
  private lastSyncAt: number | null = null
  private error: string | null = null
  private encrypted = false
  /** A senha em memória já abriu (ou cifrou) o arquivo desta sessão — só então o atalho "nada mudou" vale. */
  private passphraseVerified = false
  private pushTimer: NodeJS.Timeout | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private watcher: FSWatcher | null = null
  private running: Promise<void> | null = null
  private rerun = false
  private deviceId: string
  private unsubscribe: (() => void) | null = null

  constructor(store: Store, host: SyncHost) {
    this.store = store
    this.host = host
    this.deviceId = this.loadDeviceId()
  }

  /** Cada instalação tem um id próprio, fora do config (não viaja entre dispositivos). */
  private loadDeviceId(): string {
    const file = join(app.getPath('userData'), 'device-id')
    try {
      if (existsSync(file)) return readFileSync(file, 'utf-8').trim()
      const id = randomUUID()
      mkdirSync(app.getPath('userData'), { recursive: true })
      writeFileSync(file, id, 'utf-8')
      return id
    } catch {
      return randomUUID()
    }
  }

  start(): void {
    const settings = this.store.getState().sync
    if (!settings) return
    this.passphrase = this.readStoredPassphrase(settings)
    this.encrypted = settings.encrypted ?? settings.passphraseEnc !== null
    this.activate()
  }

  private readStoredPassphrase(settings: SyncSettings): string | null {
    if (!settings.passphraseEnc) return null
    try {
      if (!safeStorage.isEncryptionAvailable()) return null
      return safeStorage.decryptString(Buffer.from(settings.passphraseEnc, 'base64'))
    } catch {
      return null
    }
  }

  getView(): SyncView | null {
    const settings = this.store.getState().sync
    if (!settings) return null
    return {
      folder: settings.folder,
      encrypted: this.encrypted,
      status: this.status,
      lastSyncAt: this.lastSyncAt,
      error: this.error
    }
  }

  private filePath(): string | null {
    const folder = this.store.getState().sync?.folder
    return folder ? join(folder, FILE_NAME) : null
  }

  private setStatus(status: SyncView['status'], error: string | null = null): void {
    this.status = status
    this.error = error
    this.host.statusChanged()
  }

  /** Liga watchers/timers e faz uma sincronização inicial. */
  private activate(): void {
    this.deactivate()
    this.unsubscribe = this.store.onSyncableChange(() => this.schedulePush())
    this.pollTimer = setInterval(() => void this.syncNow(), POLL_INTERVAL_MS)
    const folder = this.store.getState().sync?.folder
    if (folder && existsSync(folder)) {
      try {
        // Cloud clients costumam substituir o arquivo (rename) — fs.watch pode perder eventos,
        // por isso o polling acima também existe. O watch só acelera o caso comum.
        this.watcher = watch(folder, (_event, filename) => {
          if (filename === FILE_NAME) this.schedulePull()
        })
        this.watcher.on('error', () => undefined)
      } catch {
        // pastas de rede/FS exóticos podem não suportar watch — o polling cobre.
      }
    }
    void this.syncNow()
  }

  private deactivate(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.pushTimer) clearTimeout(this.pushTimer)
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pushTimer = null
    this.pollTimer = null
    this.watcher?.close()
    this.watcher = null
  }

  private schedulePush(): void {
    if (!this.store.getState().sync) return
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = setTimeout(() => void this.syncNow(), PUSH_DEBOUNCE_MS)
  }

  private pullTimer: NodeJS.Timeout | null = null
  private schedulePull(): void {
    if (this.pullTimer) clearTimeout(this.pullTimer)
    this.pullTimer = setTimeout(() => void this.syncNow(), 500)
  }

  private async readRemote(): Promise<
    { kind: 'none' } | { kind: 'unchanged' } | { kind: 'ok'; envelope: SyncEnvelope } | { kind: 'error'; error: RemoteError }
  > {
    const file = this.filePath()
    if (!file || !existsSync(file)) return { kind: 'none' }
    let text: string
    try {
      text = readFileSync(file, 'utf-8')
    } catch {
      return { kind: 'error', error: 'corrupt' }
    }
    const head = peekEnvelope(text)
    // Sem mudança (mesmo carimbo do local — o caso comum do polling e do eco da nossa própria gravação):
    // nada a puxar nem a empurrar, então não vale gastar scrypt + AES só pra descobrir isso.
    if (head && head.updatedAt === this.store.getState().configUpdatedAt && head.encrypted === this.encrypted && (!this.encrypted || this.passphraseVerified)) {
      return { kind: 'unchanged' }
    }
    const result = await decodeEnvelope(text, this.passphrase)
    if (!result.ok) return { kind: 'error', error: result.error }
    if (result.envelope.updatedAt > Date.now() + MAX_CLOCK_SKEW_MS) return { kind: 'error', error: 'bad-clock' }
    // Quem tem escrita na pasta compartilhada poderia trocar o arquivo cifrado por um em texto puro (sem
    // autenticação) com carimbo mais novo — o GCM só protege se a gente exigir que ele esteja lá.
    if (this.encrypted && !result.envelope.encrypted) return { kind: 'error', error: 'downgrade' }
    if (result.envelope.encrypted) this.passphraseVerified = true
    return { kind: 'ok', envelope: result.envelope }
  }

  private async writeRemote(state: DeskboxState): Promise<void> {
    const file = this.filePath()
    if (!file) return
    // Exige criptografia mas a senha não está em memória (ex.: reabriu sem cofre do SO): nunca rebaixa pra texto puro.
    if (this.encrypted && !this.passphrase) throw new Error('Senha de sincronização necessária — informe-a para continuar.')
    const text = await encodeEnvelope(toSyncPayload(state), state.configUpdatedAt, this.deviceId, this.passphrase)
    // Escrita atômica: o cliente de nuvem nunca vê um arquivo pela metade.
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, text, 'utf-8')
    try {
      renameSync(tmp, file)
    } catch (error) {
      try {
        unlinkSync(tmp)
      } catch {
        // ignore
      }
      throw error
    }
    this.encrypted = this.passphrase !== null
    this.passphraseVerified = this.passphrase !== null
  }

  private setEncrypted(encrypted: boolean): void {
    this.encrypted = encrypted
    const settings = this.store.getState().sync
    if (settings && settings.encrypted !== encrypted) this.store.setState((s) => ({ ...s, sync: s.sync ? { ...s.sync, encrypted } : s.sync }))
  }

  private errorMessage(code: RemoteError): string {
    switch (code) {
      case 'bad-clock':
        return 'O arquivo de sincronização tem uma data no futuro — confira o relógio dos dispositivos.'
      case 'needs-passphrase':
        return 'O arquivo de sincronização está criptografado — informe a senha de sincronização.'
      case 'bad-passphrase':
        return 'Senha de sincronização incorreta (ou arquivo adulterado).'
      case 'downgrade':
        return 'O arquivo de sincronização está sem criptografia, mas este dispositivo exige — pode ter sido adulterado. Reative a sincronização aqui se a mudança foi proposital.'
      case 'unsupported':
        return 'O arquivo de sincronização é de uma versão mais nova do Deskbox. Atualize este dispositivo.'
      default:
        return 'Arquivo de sincronização ilegível ou corrompido.'
    }
  }

  /**
   * Puxa o remoto se for mais novo; senão empurra o local se for mais novo. Serializado: se já há uma
   * sincronização em andamento, agenda UMA repetição e devolve a promessa do conjunto — quem chama
   * (botão "Sincronizar agora", informar senha...) só retoma depois que tudo terminou, nunca com
   * status velho.
   */
  syncNow(): Promise<void> {
    if (this.running) {
      this.rerun = true
      return this.running
    }
    // `running` é zerado no `finally` do próprio laço (síncrono com a decisão de sair): num `.finally()`
    // externo ele só zeraria um tick depois, e um syncNow() chamado nessa janela marcaria `rerun` numa
    // execução que já decidiu terminar — a atualização se perderia.
    const run = (async () => {
      try {
        do {
          this.rerun = false
          await this.syncOnce()
        } while (this.rerun)
      } finally {
        this.running = null
      }
    })()
    this.running = run
    return run
  }

  private async syncOnce(): Promise<void> {
    if (!this.store.getState().sync) return
    if (this.host.isLocked()) return
    try {
      this.setStatus('syncing')
      const folder = this.store.getState().sync!.folder
      if (!existsSync(folder)) {
        this.setStatus('error', 'A pasta de sincronização não está acessível.')
        return
      }
      const remote = await this.readRemote()
      const local = this.store.getState()
      if (remote.kind === 'error') {
        this.setStatus(remote.error === 'needs-passphrase' ? 'needs-passphrase' : 'error', this.errorMessage(remote.error))
        return
      }
      if (remote.kind === 'unchanged') {
        // nada a fazer
      } else if (remote.kind === 'ok' && remote.envelope.updatedAt > local.configUpdatedAt) {
        this.host.applyRemote(remote.envelope.payload, remote.envelope.updatedAt)
        this.setEncrypted(remote.envelope.encrypted)
      } else if (remote.kind === 'none' || local.configUpdatedAt > (remote.kind === 'ok' ? remote.envelope.updatedAt : 0)) {
        await this.writeRemote(local)
      }
      this.lastSyncAt = Date.now()
      this.setStatus('idle')
    } catch (error) {
      console.error('[deskbox] Falha no sync:', error)
      this.setStatus('error', error instanceof Error ? error.message : 'Falha ao sincronizar.')
    }
  }

  /**
   * Liga o sync numa pasta. Se já existe um arquivo lá e a config deste dispositivo também tem dados,
   * devolve `conflict` pra o usuário escolher qual lado vence (`resolve`).
   */
  async enable(folder: string, passphrase: string | undefined, resolve?: 'remote' | 'local'): Promise<EnableResult> {
    if (this.host.isLocked()) return { ok: false, error: 'Destrave o app antes.' }
    if (!folder || !existsSync(folder) || !statSync(folder).isDirectory()) {
      return { ok: false, error: 'Pasta inválida.' }
    }
    const pass = passphrase?.trim() ? passphrase : null
    const previousSettings = this.store.getState().sync
    const previousPassphrase = this.passphrase
    const previousVerified = this.passphraseVerified
    this.deactivate()
    this.passphrase = pass
    this.passphraseVerified = false

    const failBack = (error: string): EnableResult => {
      this.passphrase = previousPassphrase
      this.passphraseVerified = previousVerified
      if (previousSettings) this.activate()
      return { ok: false, error }
    }

    const file = join(folder, FILE_NAME)
    let remote: Awaited<ReturnType<SyncManager['readRemote']>> = { kind: 'none' }
    if (existsSync(file)) {
      try {
        const decoded = await decodeEnvelope(readFileSync(file, 'utf-8'), pass)
        if (!decoded.ok) remote = { kind: 'error', error: decoded.error }
        else if (decoded.envelope.updatedAt > Date.now() + MAX_CLOCK_SKEW_MS) remote = { kind: 'error', error: 'bad-clock' }
        else {
          remote = { kind: 'ok', envelope: decoded.envelope }
          if (decoded.envelope.encrypted) this.passphraseVerified = true
        }
      } catch {
        remote = { kind: 'error', error: 'corrupt' }
      }
    }
    if (remote.kind === 'error') {
      // Arquivo ilegível/com outra senha: só segue se o usuário escolheu explicitamente sobrescrevê-lo.
      if (resolve !== 'local') return failBack(this.errorMessage(remote.error))
      remote = { kind: 'none' }
    }

    const local = this.store.getState()
    const localHasData = local.services.length > 0
    if (remote.kind === 'ok' && localHasData && !resolve) {
      const differs = JSON.stringify(toSyncPayload({ ...local })) !== JSON.stringify(remote.envelope.payload)
      if (differs) {
        const conflict: RemoteSummary = {
          updatedAt: remote.envelope.updatedAt,
          services: remote.envelope.payload.services.length,
          workspaces: remote.envelope.payload.workspaces.length
        }
        this.passphrase = previousPassphrase
        this.passphraseVerified = previousVerified
        if (previousSettings) this.activate()
        return { ok: false, error: 'conflict', conflict }
      }
    }

    // Guarda a configuração (a senha vai cifrada com o cofre do SO, se disponível).
    let passphraseEnc: string | null = null
    if (pass && safeStorage.isEncryptionAvailable()) {
      passphraseEnc = safeStorage.encryptString(pass).toString('base64')
    }
    this.store.setState((s) => ({ ...s, sync: { folder, passphraseEnc, encrypted: pass !== null } }))
    this.encrypted = pass !== null

    try {
      if (remote.kind === 'ok' && (resolve === 'remote' || !localHasData)) {
        this.host.applyRemote(remote.envelope.payload, remote.envelope.updatedAt)
      } else {
        // Local vence (ou não havia nada na pasta): carimbo novo, sempre maior que o do arquivo
        // que está sendo substituído, gravado também no local pra o próximo ciclo não "puxar de volta".
        const stamp = Math.max(Date.now(), remote.kind === 'ok' ? remote.envelope.updatedAt + 1 : 0)
        this.store.replaceFromRemote(this.store.getState(), stamp)
        await this.writeRemote(this.store.getState())
      }
    } catch (error) {
      this.store.setState((s) => ({ ...s, sync: previousSettings }))
      return failBack(error instanceof Error ? error.message : 'Falha ao gravar na pasta.')
    }
    this.lastSyncAt = Date.now()
    this.activate()
    return { ok: true }
  }

  /**
   * Informa a senha de sincronização quando o app não conseguiu recuperá-la (ex.: sem cofre do SO).
   * Só é guardada se o arquivo abrir com ela — uma senha errada não substitui a que já estava salva.
   */
  async providePassphrase(passphrase: string): Promise<SyncResult> {
    const settings = this.store.getState().sync
    if (!settings) return { ok: false, error: 'Sincronização não está ativa.' }
    if (this.host.isLocked()) return { ok: false, error: 'Destrave o app antes.' }
    const previous = this.passphrase
    const previousVerified = this.passphraseVerified
    this.passphrase = passphrase || null
    this.passphraseVerified = false
    await this.syncNow()
    if (this.status !== 'idle') {
      const error = this.error ?? 'Falha ao sincronizar.'
      this.passphrase = previous
      this.passphraseVerified = previousVerified
      return { ok: false, error }
    }
    const encrypted = this.passphrase !== null
    const passphraseEnc =
      this.passphrase && safeStorage.isEncryptionAvailable()
        ? safeStorage.encryptString(this.passphrase).toString('base64')
        : null
    this.encrypted = encrypted
    this.store.setState((s) => ({ ...s, sync: { ...(s.sync ?? settings), passphraseEnc, encrypted } }))
    return { ok: true }
  }

  disable(): void {
    this.deactivate()
    this.passphrase = null
    this.passphraseVerified = false
    this.encrypted = false
    this.lastSyncAt = null
    this.status = 'idle'
    this.error = null
    this.store.setState((s) => ({ ...s, sync: null }))
    this.host.statusChanged()
  }

  dispose(): void {
    this.deactivate()
  }
}
