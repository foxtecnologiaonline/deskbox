import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import type { DeskboxState } from '@shared/types'
import { syncableEqual } from './sync/payload'

const DEFAULT_WORKSPACE_ID = 'default'

const DEFAULT_STATE: DeskboxState = {
  services: [],
  workspaces: [{ id: DEFAULT_WORKSPACE_ID, name: 'Geral' }],
  activeWorkspaceId: DEFAULT_WORKSPACE_ID,
  activeInstanceId: null,
  theme: 'system',
  passwordHash: null,
  proxy: null,
  hibernateAfterMinutes: 10,
  onboardingDismissed: false,
  sidebarDensity: 'comfortable',
  notificationsEnabled: true,
  minimizeToTray: false,
  launchAtLogin: false,
  startMinimized: false,
  autoUpdate: true,
  configUpdatedAt: 0,
  sync: null
}

export class Store {
  private filePath: string
  private state: DeskboxState
  private syncableListeners = new Set<() => void>()

  constructor() {
    this.filePath = join(app.getPath('userData'), 'deskbox-config.json')
    this.state = this.load()
  }

  private load(): DeskboxState {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf-8')
        const parsed = JSON.parse(raw)
        const merged: DeskboxState = { ...DEFAULT_STATE, ...parsed }
        // Normaliza configs antigas (anteriores a workspaces/pin/ícone manual) que podem
        // não ter esses campos.
        const fallbackWorkspaceId = merged.workspaces[0]?.id ?? DEFAULT_WORKSPACE_ID
        merged.services = merged.services.map((service) => ({
          ...service,
          workspaceId: service.workspaceId ?? fallbackWorkspaceId,
          pinned: service.pinned ?? false,
          iconUrl: service.iconUrl ?? null,
          proxy: service.proxy ?? null,
          customCss: service.customCss ?? '',
          customJs: service.customJs ?? '',
          approvedJsHash: service.approvedJsHash ?? null,
          jsPendingApproval: false
        }))
        return merged
      }
    } catch (error) {
      console.error('[deskbox] Falha ao ler config, usando padrão:', error)
    }
    return { ...DEFAULT_STATE, workspaces: DEFAULT_STATE.workspaces.map((w) => ({ ...w })) }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf-8')
    } catch (error) {
      console.error('[deskbox] Falha ao salvar config:', error)
    }
  }

  getState(): DeskboxState {
    return this.state
  }

  setState(updater: (state: DeskboxState) => DeskboxState): DeskboxState {
    const previous = this.state
    this.state = updater(previous)
    const changedSyncable = !syncableEqual(previous, this.state)
    // Carimbo monotônico: nunca menor/igual ao anterior, mesmo com relógio atrasado — senão uma edição
    // local feita logo depois de receber uma config "do futuro" perderia pro remoto no last-writer-wins.
    if (changedSyncable) {
      this.state = { ...this.state, configUpdatedAt: Math.max(Date.now(), previous.configUpdatedAt + 1) }
    }
    this.persist()
    if (changedSyncable) this.syncableListeners.forEach((listener) => listener())
    return this.state
  }

  /** Aplica um estado vindo do sync mantendo o carimbo do remoto — e sem disparar um novo push. */
  replaceFromRemote(next: DeskboxState, remoteUpdatedAt: number): DeskboxState {
    this.state = { ...next, configUpdatedAt: remoteUpdatedAt }
    this.persist()
    return this.state
  }

  /** Avisa quando algo que viaja entre dispositivos mudou (não dispara por unread/hibernação etc.). */
  onSyncableChange(listener: () => void): () => void {
    this.syncableListeners.add(listener)
    return () => this.syncableListeners.delete(listener)
  }
}
