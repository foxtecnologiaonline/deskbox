import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import type { DeskboxState } from '@shared/types'

const DEFAULT_WORKSPACE_ID = 'default'

const DEFAULT_STATE: DeskboxState = {
  services: [],
  workspaces: [{ id: DEFAULT_WORKSPACE_ID, name: 'Geral' }],
  activeWorkspaceId: DEFAULT_WORKSPACE_ID,
  activeInstanceId: null,
  theme: 'system'
}

export class Store {
  private filePath: string
  private state: DeskboxState

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
        // Normaliza configs antigas (anteriores a workspaces) que podem não ter workspaceId.
        const fallbackWorkspaceId = merged.workspaces[0]?.id ?? DEFAULT_WORKSPACE_ID
        merged.services = merged.services.map((service) => ({
          ...service,
          workspaceId: service.workspaceId ?? fallbackWorkspaceId
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
    this.state = updater(this.state)
    this.persist()
    return this.state
  }
}
