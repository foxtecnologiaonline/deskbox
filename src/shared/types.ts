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

/** Estado persistido (Store). `passwordHash` nunca deve ser enviado ao renderer — ver RendererState. */
export interface DeskboxState {
  services: ServiceInstance[]
  workspaces: Workspace[]
  activeWorkspaceId: string
  activeInstanceId: string | null
  theme: Theme
  passwordHash: string | null
  proxy: ProxyConfig | null
}

export interface ProxyConfig {
  /** Ex.: "http=proxy.empresa.com:8080;https=proxy.empresa.com:8080" (sintaxe do Chromium). */
  rules: string
}

/**
 * Estado enviado ao renderer via IPC. Substitui `passwordHash` (nunca sai do main)
 * por `hasPassword`, e adiciona `locked`, calculado em tempo de execução.
 */
export type RendererState = Omit<DeskboxState, 'passwordHash'> & {
  hasPassword: boolean
  locked: boolean
}

export interface AddServicePayload {
  catalogId?: string
  name?: string
  url?: string
}

export interface SetPasswordPayload {
  newPassword: string | null
  currentPassword?: string
}

export interface SetPasswordResult {
  ok: boolean
  error?: string
}
