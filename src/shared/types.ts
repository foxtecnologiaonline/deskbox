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

export type SidebarDensity = 'comfortable' | 'compact'

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
  /** Calculado em tempo de execução: true enquanto a página está carregando (ex.: saindo de hibernação). */
  loading: boolean
  /** true = nunca hibernar este serviço, mesmo com hibernação automática ativa. */
  pinned: boolean
  /** URL de ícone manual (sobrescreve o favicon automático); só relevante pra sites personalizados. */
  iconUrl: string | null
  /** Proxy só deste serviço; null = usa o proxy global (se houver). */
  proxy: ProxyConfig | null
  /** CSS injetado na página do serviço a cada carregamento. */
  customCss: string
  /** JS executado na página do serviço a cada carregamento — só roda se aprovado neste dispositivo. */
  customJs: string
  /**
   * SHA-256 do `customJs` aprovado neste dispositivo. Nunca exportado nem sincronizado: JS que chega
   * de um arquivo importado ou de outro dispositivo só executa depois que o usuário revisa e salva aqui.
   */
  approvedJsHash: string | null
  /** Calculado em tempo de execução: true quando há `customJs` ainda não aprovado neste dispositivo. */
  jsPendingApproval: boolean
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
  /** Minutos de inatividade até hibernar um serviço; null desativa a hibernação. */
  hibernateAfterMinutes: number | null
  /** true depois que o usuário fecha o tour de boas-vindas. */
  onboardingDismissed: boolean
  sidebarDensity: SidebarDensity
  notificationsEnabled: boolean
  /** Fechar a janela minimiza pra bandeja do sistema em vez de encerrar o app. */
  minimizeToTray: boolean
  /** Inicia o Deskbox junto com o sistema operacional (app.setLoginItemSettings). */
  launchAtLogin: boolean
  /** Ao iniciar, não mostra a janela principal (fica só na bandeja). */
  startMinimized: boolean
  /** Verificar e baixar atualizações automaticamente. */
  autoUpdate: boolean
  /** Carimbo (ms) da última mudança em dados sincronizáveis — base do last-writer-wins do sync. */
  configUpdatedAt: number
  /** Sincronização por pasta (específica deste dispositivo — nunca exportada nem sincronizada). */
  sync: SyncSettings | null
}

export interface SyncSettings {
  folder: string
  /** Senha de criptografia do arquivo de sync, cifrada com o cofre do SO (safeStorage); base64. */
  passphraseEnc: string | null
}

/** Visão do sync enviada ao renderer (sem a senha). */
export interface SyncView {
  folder: string
  encrypted: boolean
  status: 'idle' | 'syncing' | 'error' | 'needs-passphrase'
  lastSyncAt: number | null
  error: string | null
}

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'not-available'
  | 'error'
  | 'unsupported'

export interface UpdateStatus {
  state: UpdateState
  currentVersion: string
  version?: string
  /** 0..100 durante o download. */
  progress?: number
  error?: string
  /** true no build portátil: só avisa da versão nova, não instala sozinho. */
  portable?: boolean
  releaseUrl?: string
}

export interface ProxyConfig {
  /** Ex.: "http=proxy.empresa.com:8080;https=proxy.empresa.com:8080" (sintaxe do Chromium). */
  rules: string
}

/**
 * Estado enviado ao renderer via IPC. Substitui `passwordHash` (nunca sai do main)
 * por `hasPassword`, e adiciona `locked`, calculado em tempo de execução.
 */
export type RendererState = Omit<DeskboxState, 'passwordHash' | 'sync'> & {
  hasPassword: boolean
  locked: boolean
  sync: SyncView | null
}

export interface AddServicePayload {
  catalogId?: string
  name?: string
  url?: string
  iconUrl?: string
}

export interface SetPasswordPayload {
  newPassword: string | null
  currentPassword?: string
}

export interface SetPasswordResult {
  ok: boolean
  error?: string
}

/** Configuração exportável (backup/transferência) — nunca inclui passwordHash. */
export type ExportedConfig = Omit<DeskboxState, 'passwordHash' | 'sync' | 'configUpdatedAt'>

export interface ServiceSettingsPayload {
  instanceId: string
  proxy: ProxyConfig | null
  customCss: string
  customJs: string
}

export interface SetSyncPayload {
  folder: string
  /** Senha de criptografia (opcional). Vazia/ausente = arquivo de sync em texto simples. */
  passphrase?: string
}

export interface SyncResult {
  ok: boolean
  error?: string
}

export interface ImportConfigResult {
  ok: boolean
  error?: string
}

export interface PairingInfo {
  code: string
  expiresAt: number
  port: number
  /** IPv4 da LAN, privados primeiro. */
  hosts: string[]
  /** deskbox://pair?host=..&port=..&code=.. — o que o QR codifica. */
  uri: string
}

export interface PhoneEvent {
  type: 'paired' | 'online' | 'offline'
  deviceId: string
  name: string
}
