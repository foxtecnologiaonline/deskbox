import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from 'crypto'
import { promisify } from 'util'
import { parseSyncPayload, type SyncPayload } from './payload'

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>

const FORMAT = 'deskbox-sync'
const VERSION = 1
const KDF = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

export interface SyncEnvelope {
  updatedAt: number
  deviceId: string
  encrypted: boolean
  payload: SyncPayload
}

export type DecodeError = 'corrupt' | 'needs-passphrase' | 'bad-passphrase' | 'unsupported'

export type DecodeResult = { ok: true; envelope: SyncEnvelope } | { ok: false; error: DecodeError }

/** Cabeçalho que vai como AAD no AES-GCM: adulterar `updatedAt`/`deviceId` invalida a autenticação. */
function aad(updatedAt: number, deviceId: string): Buffer {
  return Buffer.from(`${FORMAT}|${VERSION}|${updatedAt}|${deviceId}`, 'utf-8')
}

export async function encodeEnvelope(
  payload: SyncPayload,
  updatedAt: number,
  deviceId: string,
  passphrase: string | null
): Promise<string> {
  const head = { format: FORMAT, version: VERSION, updatedAt, deviceId }
  if (!passphrase) {
    return JSON.stringify({ ...head, encrypted: false, payload }, null, 2)
  }
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = await scrypt(passphrase, salt, 32, KDF)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad(updatedAt, deviceId))
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf-8'), cipher.final()])
  return JSON.stringify(
    {
      ...head,
      encrypted: true,
      kdf: { alg: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, salt: salt.toString('base64') },
      cipher: { alg: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
      data: data.toString('base64')
    },
    null,
    2
  )
}

export async function decodeEnvelope(text: string, passphrase: string | null): Promise<DecodeResult> {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: 'corrupt' }
  }
  if (!raw || raw.format !== FORMAT) return { ok: false, error: 'corrupt' }
  if (raw.version !== VERSION) return { ok: false, error: 'unsupported' }
  const updatedAt = raw.updatedAt
  const deviceId = raw.deviceId
  if (typeof updatedAt !== 'number' || typeof deviceId !== 'string') return { ok: false, error: 'corrupt' }

  if (raw.encrypted !== true) {
    const payload = parseSyncPayload(raw.payload)
    return payload ? { ok: true, envelope: { updatedAt, deviceId, encrypted: false, payload } } : { ok: false, error: 'corrupt' }
  }

  if (!passphrase) return { ok: false, error: 'needs-passphrase' }
  try {
    const kdf = raw.kdf as { N: number; r: number; p: number; salt: string }
    const cipherInfo = raw.cipher as { iv: string; tag: string }
    // Parâmetros do KDF vêm de um arquivo de fora: limita pra um arquivo malicioso não pedir
    // gigabytes de memória (DoS) no scrypt.
    if (!(kdf.N >= 1024 && kdf.N <= 1 << 17 && kdf.r >= 1 && kdf.r <= 16 && kdf.p >= 1 && kdf.p <= 4)) {
      return { ok: false, error: 'corrupt' }
    }
    const key = await scrypt(passphrase, Buffer.from(kdf.salt, 'base64'), 32, {
      N: kdf.N,
      r: kdf.r,
      p: kdf.p,
      maxmem: 256 * 1024 * 1024
    })
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(cipherInfo.iv, 'base64'))
    decipher.setAAD(aad(updatedAt, deviceId))
    decipher.setAuthTag(Buffer.from(cipherInfo.tag, 'base64'))
    const plain = Buffer.concat([decipher.update(Buffer.from(raw.data as string, 'base64')), decipher.final()])
    const payload = parseSyncPayload(JSON.parse(plain.toString('utf-8')))
    return payload ? { ok: true, envelope: { updatedAt, deviceId, encrypted: true, payload } } : { ok: false, error: 'corrupt' }
  } catch {
    // GCM falha a autenticação tanto com senha errada quanto com arquivo adulterado.
    return { ok: false, error: 'bad-passphrase' }
  }
}
