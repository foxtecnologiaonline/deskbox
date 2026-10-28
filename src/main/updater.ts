import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '@shared/types'

const FIRST_CHECK_DELAY_MS = 15 * 1000
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
const RELEASES_URL = 'https://github.com/foxtecnologiaonline/deskbox/releases'

/**
 * Auto-update via electron-updater + GitHub Releases (ver .github/workflows/release.yml).
 * - Instalador NSIS (Windows) e AppImage (Linux): baixa em segundo plano e instala ao reiniciar.
 * - Build portátil: não dá pra se auto-substituir (é um .exe avulso) — só avisa da versão nova com o link.
 * - macOS: o auto-update só funciona com o app assinado/notarizado (exigência do Squirrel.Mac).
 */
export class Updater {
  private status: UpdateStatus
  private timer: NodeJS.Timeout | null = null
  private portable = Boolean(process.env['PORTABLE_EXECUTABLE_DIR'])

  constructor(
    private onStatus: (status: UpdateStatus) => void,
    private isAutoEnabled: () => boolean
  ) {
    this.status = { state: 'idle', currentVersion: app.getVersion(), portable: this.portable }
    // Portátil só avisa; instalador baixa sozinho assim que encontra.
    autoUpdater.autoDownload = !this.portable
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = false
    autoUpdater.logger = null

    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }))
    autoUpdater.on('update-available', (info) => {
      this.set({
        state: this.portable ? 'available' : 'downloading',
        version: info.version,
        progress: 0,
        releaseUrl: `${RELEASES_URL}/tag/v${info.version}`
      })
    })
    autoUpdater.on('update-not-available', () => this.set({ state: 'not-available', version: undefined }))
    autoUpdater.on('download-progress', (p) => this.set({ state: 'downloading', progress: Math.round(p.percent) }))
    autoUpdater.on('update-downloaded', (info) => this.set({ state: 'downloaded', version: info.version, progress: 100 }))
    autoUpdater.on('error', (error) => this.set({ state: 'error', error: this.friendlyError(error) }))
  }

  private friendlyError(error: Error): string {
    const message = error?.message ?? String(error)
    if (/404|Not Found|Cannot find latest/i.test(message)) {
      return 'Nenhuma versão publicada encontrada (ou o repositório de releases não é público).'
    }
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::/i.test(message)) return 'Sem conexão com o servidor de atualizações.'
    return message.split('\n')[0].slice(0, 200)
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, error: undefined, ...patch, currentVersion: app.getVersion(), portable: this.portable }
    this.onStatus(this.status)
  }

  getStatus(): UpdateStatus {
    return this.status
  }

  /** Agenda a checagem automática (primeira logo após abrir, depois a cada 4h) respeitando a preferência. */
  start(): void {
    setTimeout(() => {
      if (this.isAutoEnabled()) void this.check()
    }, FIRST_CHECK_DELAY_MS)
    this.timer = setInterval(() => {
      if (this.isAutoEnabled()) void this.check()
    }, CHECK_INTERVAL_MS)
  }

  async check(): Promise<UpdateStatus> {
    if (!app.isPackaged) {
      this.set({ state: 'unsupported', error: 'Atualizações só funcionam no app instalado (não em modo de desenvolvimento).' })
      return this.status
    }
    if (this.status.state === 'checking' || this.status.state === 'downloading' || this.status.state === 'downloaded') {
      return this.status
    }
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      // O listener 'error' já cobre a maioria dos casos; este catch pega rejeições sem evento.
      this.set({ state: 'error', error: this.friendlyError(error as Error) })
    }
    return this.status
  }

  /** Fecha o app e instala a atualização já baixada. `prepareToQuit` libera o fechar-pra-bandeja. */
  install(prepareToQuit: () => void): void {
    if (this.status.state !== 'downloaded') return
    prepareToQuit()
    autoUpdater.quitAndInstall(false, true)
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
  }
}
