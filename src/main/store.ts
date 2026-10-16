import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import type { DeskboxState } from '@shared/types'

const DEFAULT_STATE: DeskboxState = {
  services: [],
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
        return { ...DEFAULT_STATE, ...parsed }
      }
    } catch (error) {
      console.error('[deskbox] Falha ao ler config, usando padrão:', error)
    }
    return { ...DEFAULT_STATE }
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
