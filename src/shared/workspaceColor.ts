const PALETTE = ['#5b8def', '#e2795b', '#4caf82', '#b06ae0', '#e0b24c', '#4bb3c9', '#e06a9d', '#8a8f98']

/** Cor determinística por id de workspace — mesmo workspace sempre tem a mesma cor, sem precisar persistir nada. */
export function workspaceColor(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0
  }
  return PALETTE[Math.abs(hash) % PALETTE.length]
}
