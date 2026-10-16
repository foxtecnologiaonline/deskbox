export type Theme = 'light' | 'dark' | 'system'

export interface CatalogEntry {
  id: string
  name: string
  url: string
  domain: string
  category: string
}

export interface Workspace {
  id: string
  name: string
}

export interface ServiceInstance {
  instanceId: string
  catalogId: string
  name: string
  url: string
  domain: string
  partition: string
  workspaceId: string
  order: number
  muted: boolean
  unreadCount: number
  /** Calculado em tempo de execução: true quando o BrowserView foi descarregado da memória. */
  hibernated: boolean
}

export interface DeskboxState {
  services: ServiceInstance[]
  workspaces: Workspace[]
  activeWorkspaceId: string
  activeInstanceId: string | null
  theme: Theme
}

export interface AddServicePayload {
  catalogId?: string
  name?: string
  url?: string
}
