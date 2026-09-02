
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'crypto'

export const SEALED_PROTOCOL_V = 3

const HINT_CONTEXT = 'caduceus.ws.hint.v1'
const HKDF_INFO = 'caduceus.sealed.v3'
const AAD_C2S = 'caduceus.v3.c2s'
const AAD_S2C = 'caduceus.v3.s2c'
const NONCE_BYTES = 16
const GCM_IV_BYTES = 12
const GCM_TAG_BYTES = 16
const MAX_BOX_BYTES = 256 * 1024


export function deriveInviteHint(token: string): string {
  return createHmac('sha256', HINT_CONTEXT).update(token).digest('hex').slice(0, 16)
}

export interface SealedKeys {
  c2s: Buffer
  s2c: Buffer
}

export function deriveSealedKeys(token: string, nonceS: Buffer, nonceC: Buffer): SealedKeys {
  const okm = Buffer.from(
    hkdfSync('sha256', Buffer.from(token, 'utf8'), Buffer.concat([nonceS, nonceC]), HKDF_INFO, 64),
  )
  return { c2s: okm.subarray(0, 32), s2c: okm.subarray(32, 64) }
}

export function mintHandshakeNonce(): Buffer {
  return randomBytes(NONCE_BYTES)
}


function ivForCounter(n: number): Buffer {
  const iv = Buffer.alloc(GCM_IV_BYTES)
  iv.writeBigUInt64BE(BigInt(n), 4)
  return iv
}

function sealRaw(key: Buffer, n: number, aad: string, plaintext: Buffer): string {
  const cipher = createCipheriv('aes-256-gcm', key, ivForCounter(n))
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
  return ct.toString('base64')
}

function openRaw(key: Buffer, n: number, aad: string, ctB64: string): Buffer | null {
  let ct: Buffer
  try {
    ct = Buffer.from(ctB64, 'base64')
  } catch {
    return null
  }
  if (ct.length < GCM_TAG_BYTES || ct.length > MAX_BOX_BYTES + GCM_TAG_BYTES) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, ivForCounter(n))
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(ct.subarray(ct.length - GCM_TAG_BYTES))
    return Buffer.concat([
      decipher.update(ct.subarray(0, ct.length - GCM_TAG_BYTES)),
      decipher.final(),
    ])
  } catch {
    return null
  }
}


export interface HelloMessage {
  type: 'hello'
  v: number
}
export interface ChallengeMessage {
  type: 'challenge'
  v: number
  nonce: string
}
export interface AuthMessage {
  type: 'auth'
  hint: string
  nonce: string
  box: string
}
export interface BoxMessage {
  type: 'box'
  n: number
  ct: string
}

export interface AuthPayload {
  nonceS: string
  sinceSeq?: number
  name?: string
}

export function buildHello(): HelloMessage {
  return { type: 'hello', v: SEALED_PROTOCOL_V }
}

export function buildChallenge(nonceS: Buffer): ChallengeMessage {
  return { type: 'challenge', v: SEALED_PROTOCOL_V, nonce: nonceS.toString('base64') }
}

export function buildAuth(token: string, keys: SealedKeys, nonceC: Buffer, payload: AuthPayload): AuthMessage {
  return {
    type: 'auth',
    hint: deriveInviteHint(token),
    nonce: nonceC.toString('base64'),
    box: sealRaw(keys.c2s, 0, AAD_C2S, Buffer.from(JSON.stringify(payload), 'utf8')),
  }
}

export function openAuthBox(keys: SealedKeys, box: string): AuthPayload | null {
  const pt = openRaw(keys.c2s, 0, AAD_C2S, box)
  if (!pt) return null
  try {
    const obj = JSON.parse(pt.toString('utf8')) as AuthPayload
    if (typeof obj !== 'object' || obj === null) return null
    if (typeof obj.nonceS !== 'string') return null
    return obj
  } catch {
    return null
  }
}

export function isHelloMessage(m: unknown): m is HelloMessage {
  return (
    typeof m === 'object' && m !== null && (m as HelloMessage).type === 'hello' &&
    typeof (m as HelloMessage).v === 'number'
  )
}
export function isChallengeMessage(m: unknown): m is ChallengeMessage {
  return (
    typeof m === 'object' && m !== null && (m as ChallengeMessage).type === 'challenge' &&
    typeof (m as ChallengeMessage).nonce === 'string'
  )
}
export function isAuthMessage(m: unknown): m is AuthMessage {
  const a = m as AuthMessage
  return (
    typeof m === 'object' && m !== null && a.type === 'auth' &&
    typeof a.hint === 'string' && typeof a.nonce === 'string' && typeof a.box === 'string'
  )
}
export function isBoxMessage(m: unknown): m is BoxMessage {
  const b = m as BoxMessage
  return (
    typeof m === 'object' && m !== null && b.type === 'box' &&
    typeof b.n === 'number' && typeof b.ct === 'string'
  )
}

export function parseHandshakeNonce(b64: string): Buffer | null {
  let buf: Buffer
  try {
    buf = Buffer.from(b64, 'base64')
  } catch {
    return null
  }
  return buf.length === NONCE_BYTES ? buf : null
}


export type SealedFailure = 'tamper' | 'replay' | 'malformed'

export class SealedLinkError extends Error {
  constructor(readonly reason: SealedFailure) {
    super(`sealed channel violation: ${reason}`)
  }
}

export class SealedLink {
  private readonly sendKey: Buffer
  private readonly recvKey: Buffer
  private readonly sendAad: string
  private readonly recvAad: string
  private sendN: number
  private recvLast: number

  constructor(keys: SealedKeys, side: 'client' | 'server') {
    if (side === 'client') {
      this.sendKey = keys.c2s
      this.recvKey = keys.s2c
      this.sendAad = AAD_C2S
      this.recvAad = AAD_S2C
      this.sendN = 1
      this.recvLast = -1
    } else {
      this.sendKey = keys.s2c
      this.recvKey = keys.c2s
      this.sendAad = AAD_S2C
      this.recvAad = AAD_C2S
      this.sendN = 0
      this.recvLast = 0
    }
  }

  seal(msg: unknown): BoxMessage {
    const n = this.sendN
    this.sendN += 1
    return {
      type: 'box',
      n,
      ct: sealRaw(this.sendKey, n, this.sendAad, Buffer.from(JSON.stringify(msg), 'utf8')),
    }
  }

  open(box: BoxMessage): unknown {
    if (!Number.isSafeInteger(box.n) || box.n < 0) throw new SealedLinkError('malformed')
    if (box.n <= this.recvLast) throw new SealedLinkError('replay')
    const pt = openRaw(this.recvKey, box.n, this.recvAad, box.ct)
    if (!pt) throw new SealedLinkError('tamper')
    this.recvLast = box.n
    try {
      return JSON.parse(pt.toString('utf8'))
    } catch {
      throw new SealedLinkError('malformed')
    }
  }
}


export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h === '::1') return true
  if (/^127(\.\d{1,3}){3}$/.test(h)) return true
  if (h.startsWith('::ffff:127.')) return true
  return false
}
