// Stub mínimo do módulo "electron" pra rodar Store/SyncManager em testes no Node puro.
let userData = ''
export function __setUserData(dir: string): void {
  userData = dir
}
export const app = {
  getPath: (_name: string): string => userData,
  getVersion: (): string => '0.0.0-test',
  isPackaged: false
}
export const safeStorage = {
  isEncryptionAvailable: (): boolean => true,
  encryptString: (value: string): Buffer => Buffer.from(`enc:${value}`, 'utf-8'),
  decryptString: (buf: Buffer): string => buf.toString('utf-8').replace(/^enc:/, '')
}
