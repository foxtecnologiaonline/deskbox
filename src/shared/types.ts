export type Theme = 'light' | 'dark' | 'system'

export interface CatalogEntry {
  id: string
  name: string
  url: string
  domain: string
  category: string
}

export interface ServiceInstance {
  instanceId: string
  catalogId: string
  name: string
  url: string
  domain: string
  partition: string
  order: number
  muted: boolean
  unreadCount: number
}

export interface DeskboxState {
  services: ServiceInstance[]
  activeInstanceId: string | null
  theme: Theme
}

export interface AddServicePayload {
  catalogId?: string
  name?: string
  url?: string
}
