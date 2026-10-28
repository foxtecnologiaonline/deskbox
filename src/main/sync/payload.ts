import type { DeskboxState, ServiceInstance, SidebarDensity, Theme, Workspace } from '@shared/types'
import { PHONE_CATALOG_ID } from '@shared/phone'

/**
 * O que viaja entre dispositivos. Ficam de fora (de propósito):
 * - dados de runtime (unreadCount, hibernated, loading);
 * - segredos/estado local: passwordHash, sessões (logins vivem nas partições do Chromium, não aqui);
 * - serviços "Celular Android": o pareamento (token) é por computador;
 * - preferências de dispositivo: proxy global e por serviço (rede do trabalho ≠ rede de casa),
 *   bandeja/iniciar com o sistema/iniciar minimizado, config do próprio sync;
 * - estado de navegação local: workspace/serviço ativo;
 * - aprovação de JS (`approvedJsHash`): JS vindo de fora nunca executa sem o usuário revisar neste dispositivo.
 */
export interface SyncedService {
  instanceId: string
  catalogId: string
  name: string
  url: string
  domain: string
  partition: string
  workspaceId: string
  order: number
  muted: boolean
  pinned: boolean
  iconUrl: string | null
  customCss: string
  customJs: string
}

export interface SyncPayload {
  services: SyncedService[]
  workspaces: Workspace[]
  theme: Theme
  hibernateAfterMinutes: number | null
  onboardingDismissed: boolean
  sidebarDensity: SidebarDensity
  notificationsEnabled: boolean
}

export const MAX_CUSTOM_CODE_LENGTH = 200_000

/**
 * Só serviços "normais" viajam: sem celular (pareamento local) e só com URL http(s) válida — um serviço
 * com URL inválida nunca pode entrar no arquivo (o parse do outro lado recusaria o arquivo inteiro).
 */
export function isSyncableService(s: ServiceInstance): boolean {
  return s.catalogId !== PHONE_CATALOG_ID && isHttpUrl(s.url)
}

export function toSyncPayload(state: DeskboxState): SyncPayload {
  return {
    services: state.services
      .filter(isSyncableService)
      .map((s) => ({
      instanceId: s.instanceId,
      catalogId: s.catalogId,
      name: s.name,
      url: s.url,
      domain: s.domain,
      partition: s.partition,
      workspaceId: s.workspaceId,
      order: s.order,
      muted: s.muted,
      pinned: s.pinned,
      iconUrl: s.iconUrl,
      customCss: s.customCss,
      customJs: s.customJs
    })),
    workspaces: state.workspaces,
    theme: state.theme,
    hibernateAfterMinutes: state.hibernateAfterMinutes,
    onboardingDismissed: state.onboardingDismissed,
    sidebarDensity: state.sidebarDensity,
    notificationsEnabled: state.notificationsEnabled
  }
}

/** Assinatura estável do que é sincronizável — muda só quando algo que viaja entre dispositivos muda. */
export function syncSignature(state: DeskboxState): string {
  return JSON.stringify(toSyncPayload(state))
}

/**
 * Equivalente a comparar `syncSignature`, mas sem serializar nada: compara campo a campo (strings
 * inalteradas são a mesma referência, então CSS/JS grandes custam O(1)). Roda a cada `setState`
 * (unread, seleção...), por isso precisa ser barata.
 */
export function syncableEqual(a: DeskboxState, b: DeskboxState): boolean {
  if (
    a.theme !== b.theme ||
    a.hibernateAfterMinutes !== b.hibernateAfterMinutes ||
    a.onboardingDismissed !== b.onboardingDismissed ||
    a.sidebarDensity !== b.sidebarDensity ||
    a.notificationsEnabled !== b.notificationsEnabled
  ) {
    return false
  }
  if (a.workspaces !== b.workspaces) {
    if (a.workspaces.length !== b.workspaces.length) return false
    for (let i = 0; i < a.workspaces.length; i++) {
      if (a.workspaces[i].id !== b.workspaces[i].id || a.workspaces[i].name !== b.workspaces[i].name) return false
    }
  }
  if (a.services === b.services) return true
  const sa = a.services.filter(isSyncableService)
  const sb = b.services.filter(isSyncableService)
  if (sa.length !== sb.length) return false
  for (let i = 0; i < sa.length; i++) {
    const x = sa[i]
    const y = sb[i]
    if (
      x !== y &&
      (x.instanceId !== y.instanceId ||
        x.catalogId !== y.catalogId ||
        x.name !== y.name ||
        x.url !== y.url ||
        x.domain !== y.domain ||
        x.partition !== y.partition ||
        x.workspaceId !== y.workspaceId ||
        x.order !== y.order ||
        x.muted !== y.muted ||
        x.pinned !== y.pinned ||
        x.iconUrl !== y.iconUrl ||
        x.customCss !== y.customCss ||
        x.customJs !== y.customJs)
    ) {
      return false
    }
  }
  return true
}

/** Só http(s): um arquivo de config de fora nunca pode apontar um serviço pra file://, javascript: etc. */
export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

const THEMES = new Set<Theme>(['light', 'dark', 'system'])
const DENSITIES = new Set<SidebarDensity>(['comfortable', 'compact'])

function str(value: unknown): value is string {
  return typeof value === 'string'
}

/** Valida um serviço vindo de fora (arquivo importado ou de sync) e devolve só os campos conhecidos. */
export function sanitizeService(raw: unknown, workspaceIds: Set<string>): SyncedService | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  if (!str(s.instanceId) || !str(s.partition) || !isHttpUrl(s.url)) return null
  if (!str(s.workspaceId) || !workspaceIds.has(s.workspaceId)) return null
  const customCss = str(s.customCss) ? s.customCss : ''
  const customJs = str(s.customJs) ? s.customJs : ''
  if (customCss.length > MAX_CUSTOM_CODE_LENGTH || customJs.length > MAX_CUSTOM_CODE_LENGTH) return null
  return {
    instanceId: s.instanceId,
    // Um arquivo de fora nunca cria um serviço de celular (isso só acontece pelo pareamento local).
    catalogId: str(s.catalogId) && s.catalogId !== PHONE_CATALOG_ID ? s.catalogId : 'custom',
    name: str(s.name) ? s.name : 'Serviço',
    url: s.url,
    domain: str(s.domain) ? s.domain : new URL(s.url).hostname,
    partition: s.partition,
    workspaceId: s.workspaceId,
    order: typeof s.order === 'number' ? s.order : 0,
    muted: s.muted === true,
    pinned: s.pinned === true,
    iconUrl: isHttpUrl(s.iconUrl) ? s.iconUrl : null,
    customCss,
    customJs
  }
}

/** Valida um payload inteiro vindo de fora. null = inválido (nada é aplicado). */
export function parseSyncPayload(raw: unknown): SyncPayload | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  if (!Array.isArray(p.services) || !Array.isArray(p.workspaces) || p.workspaces.length === 0) return null
  const workspaces: Workspace[] = []
  for (const w of p.workspaces) {
    if (!w || typeof w !== 'object') return null
    const { id, name } = w as Record<string, unknown>
    if (!str(id) || !str(name)) return null
    workspaces.push({ id, name })
  }
  const workspaceIds = new Set(workspaces.map((w) => w.id))
  const services: SyncedService[] = []
  for (const raw of p.services) {
    const service = sanitizeService(raw, workspaceIds)
    if (!service) return null
    services.push(service)
  }
  const hibernate = p.hibernateAfterMinutes
  return {
    services,
    workspaces,
    theme: THEMES.has(p.theme as Theme) ? (p.theme as Theme) : 'system',
    hibernateAfterMinutes: typeof hibernate === 'number' && hibernate > 0 ? hibernate : null,
    onboardingDismissed: p.onboardingDismissed === true,
    sidebarDensity: DENSITIES.has(p.sidebarDensity as SidebarDensity)
      ? (p.sidebarDensity as SidebarDensity)
      : 'comfortable',
    notificationsEnabled: p.notificationsEnabled !== false
  }
}

/**
 * Aplica um payload remoto por cima do estado local, preservando o que é só deste dispositivo
 * (proxies, unread, aprovação de JS, workspace/serviço ativo, flags de bandeja etc.).
 */
export function applyPayload(local: DeskboxState, remote: SyncPayload): DeskboxState {
  const localById = new Map(local.services.map((s) => [s.instanceId, s]))
  const localPhones = local.services.filter((s) => s.catalogId === PHONE_CATALOG_ID)
  const services: ServiceInstance[] = remote.services.map((r) => {
    const l = localById.get(r.instanceId)
    return {
      ...r,
      unreadCount: l?.unreadCount ?? 0,
      hibernated: false,
      loading: false,
      proxy: l?.proxy ?? null,
      approvedJsHash: l?.approvedJsHash ?? null,
      jsPendingApproval: false
    }
  })
  // Celulares pareados são locais a este computador: o sync nunca os cria nem remove.
  // Se o workspace do celular não existe no remoto, ele é movido pro primeiro (nunca descartado: sumir da
  // sidebar deixaria o pareamento ativo sem nenhuma UI pra revogar).
  const remoteWorkspaceIds = new Set(remote.workspaces.map((w) => w.id))
  services.push(
    ...localPhones.map((p) => (remoteWorkspaceIds.has(p.workspaceId) ? p : { ...p, workspaceId: remote.workspaces[0].id }))
  )
  const workspaceIds = new Set(remote.workspaces.map((w) => w.id))
  const activeWorkspaceId = workspaceIds.has(local.activeWorkspaceId) ? local.activeWorkspaceId : remote.workspaces[0].id
  const activeStillExists = services.some(
    (s) => s.instanceId === local.activeInstanceId && s.workspaceId === activeWorkspaceId
  )
  return {
    ...local,
    services,
    workspaces: remote.workspaces,
    theme: remote.theme,
    hibernateAfterMinutes: remote.hibernateAfterMinutes,
    onboardingDismissed: remote.onboardingDismissed,
    sidebarDensity: remote.sidebarDensity,
    notificationsEnabled: remote.notificationsEnabled,
    activeWorkspaceId,
    activeInstanceId: activeStillExists ? local.activeInstanceId : null
  }
}
