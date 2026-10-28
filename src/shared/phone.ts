/** Serviço especial "Celular Android": a URL guardada é um marcador; a real (porta dinâmica) é resolvida em runtime. */
export const PHONE_CATALOG_ID = 'android-phone'
export const PHONE_URL_PREFIX = 'deskbox-phone://'

export function phoneServiceUrl(deviceId: string): string {
  return `${PHONE_URL_PREFIX}${deviceId}`
}

export function phoneDeviceIdFromUrl(url: string): string | null {
  return url.startsWith(PHONE_URL_PREFIX) ? url.slice(PHONE_URL_PREFIX.length) : null
}

/** Ícone embutido (SVG) — evita depender do favicon de "127.0.0.1". */
export const PHONE_ICON =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="18" y="6" width="28" height="52" rx="6" fill="#2b6fff"/><rect x="22" y="12" width="20" height="36" rx="2" fill="#0f1115"/><circle cx="32" cy="53" r="2.5" fill="#fff"/></svg>'
  )
