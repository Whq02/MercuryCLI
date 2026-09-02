/**
 * Caduceus sealed channel — protocol v3: the invite token NEVER crosses the wire.
 *
 * v2 sent `{type:'join', token}` in cleartext, so a `ws://` hop off-loopback
 * exposed the bearer credential (and every frame) to the path unless the
 * operator hand-built a TLS tunnel. v3 keeps the tunnel RECOMMENDED for
 * availability but not required for confidentiality:
 *
 *   client → hello     {v:3}                         (plaintext, empty)
 *   server → challenge {v:3, nonce: nonceS}          (plaintext, random)
 *   client → auth      {hint, nonce: nonceC, box}    (box = AEAD proof)
 *   then EVERYTHING both ways rides {type:'box', n, ct} envelopes carrying the
 *   EXACT v2 message vocabulary sealed in AES-256-GCM.
 *
 * TRUST ROOT: the invite token itself (high-entropy, minted by /invite, held
 * by exactly the two parties). Keys are HKDF-SHA256(ikm=token,
 * salt=nonceS‖nonceC, info=v3) → two 32-byte direction keys. The auth box is
 * sealed under the client→server key at counter 0 and must echo nonceS —
 * opening it proves token possession WITHOUT revealing the token; echoing
 * nonceS kills replay of a recorded handshake (fresh server nonce per
 * connection ⇒ fresh keys per connection).
 *
 * HINT: a non-secret HMAC-derived tag of the token (never a token substring —
 * the ratified property is "the token never crosses the wire", so not even a
 * prefix rides it). The server uses it only to select CANDIDATE invites to
 * try-verify at auth time; every hello is answered with a challenge whether or
 * not anything matches, so the wire never oracles token existence.
 *
 * COUNTERS: per-direction strictly-increasing message counters ARE the AEAD
 * nonces (12-byte big-endian, keys are per-direction + per-connection so
 * counter nonces cannot collide). The receiver enforces strict increase:
 * tamper ⇒ open fails; replay/reorder ⇒ counter check fails; either tears the
 * connection down (attacks are LOUD, and a torn client reconnects with a
 * fresh handshake).
 *
 * Leaf module: pure node `crypto`, no fs, no imports from the fabric. The
 * retired room transport's server and its thin client (fs-free for the
 * Windows path) were its importers; both left with that estate. Today no
 * product module imports it — the channel barrel (index.ts) re-exports it
 * as the extracted primitive the next multiplayer builds on, and
 * scripts/channel/ holds its proofs, loading it directly.
 */

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'crypto'

export const SEALED_PROTOCOL_V = 3

const HINT_CONTEXT = 'caduceus.ws.hint.v1'
const HKDF_INFO = 'caduceus.sealed.v3'
const AAD_C2S = 'caduceus.v3.c2s'
const AAD_S2C = 'caduceus.v3.s2c'
const NONCE_BYTES = 16
const GCM_IV_BYTES = 12
const GCM_TAG_BYTES = 16
/** Sealed payload ceiling — matches the transport's MAX_MESSAGE_BYTES. */
const MAX_BOX_BYTES = 256 * 1024

// ---------------------------------------------------------------------------
// Key + hint derivation.
// ---------------------------------------------------------------------------

/** Non-secret candidate-selection tag for a token (16 hex chars). */
export function deriveInviteHint(token: string): string {
  return createHmac('sha256', HINT_CONTEXT).update(token).digest('hex').slice(0, 16)
}

export interface SealedKeys {
  /** client→server direction key (32 bytes). */
  c2s: Buffer
  /** server→client direction key (32 bytes). */
  s2c: Buffer
}

/** HKDF both direction keys from the token + both handshake nonces. */
export function deriveSealedKeys(token: string, nonceS: Buffer, nonceC: Buffer): SealedKeys {
  const okm = Buffer.from(
    hkdfSync('sha256', Buffer.from(token, 'utf8'), Buffer.concat([nonceS, nonceC]), HKDF_INFO, 64),
  )
  return { c2s: okm.subarray(0, 32), s2c: okm.subarray(32, 64) }
}

/** Fresh handshake nonce (16 random bytes). */
export function mintHandshakeNonce(): Buffer {
  return randomBytes(NONCE_BYTES)
}

// ---------------------------------------------------------------------------
// AEAD box primitives (internal — SealedLink + the auth box wrap these).
// ---------------------------------------------------------------------------

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

/** Returns null on ANY failure (tamper, wrong key, malformed) — never throws. */
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

// ---------------------------------------------------------------------------
// Handshake messages.
// ---------------------------------------------------------------------------

export interface HelloMessage {
  type: 'hello'
  v: number
}
export interface ChallengeMessage {
  type: 'challenge'
  v: number
  /** nonceS, base64. */
  nonce: string
}
export interface AuthMessage {
  type: 'auth'
  hint: string
  /** nonceC, base64. */
  nonce: string
  /** The auth proof: AEAD box (c2s key, counter 0) of AuthPayload. */
  box: string
}
export interface BoxMessage {
  type: 'box'
  n: number
  ct: string
}

/** What the auth box seals: the nonceS echo + the v2 join fields (token ABSENT
 *  by design — the box opening under invite-derived keys IS the credential). */
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

/** Try to open an auth box under candidate keys. Null ⇒ not this candidate. */
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

/** Parse a base64 handshake nonce with the exact expected length, or null. */
export function parseHandshakeNonce(b64: string): Buffer | null {
  let buf: Buffer
  try {
    buf = Buffer.from(b64, 'base64')
  } catch {
    return null
  }
  return buf.length === NONCE_BYTES ? buf : null
}

// ---------------------------------------------------------------------------
// The steady-state sealed link.
// ---------------------------------------------------------------------------

export type SealedFailure = 'tamper' | 'replay' | 'malformed'

export class SealedLinkError extends Error {
  constructor(readonly reason: SealedFailure) {
    super(`sealed channel violation: ${reason}`)
  }
}

/**
 * One side of an established v3 connection. Construction encodes the counter
 * hand-off from the handshake: the auth box consumed c2s counter 0, so the
 * client sends from 1 and the server refuses any c2s counter ≤ 0.
 */
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
      this.sendN = 1 // 0 was the auth box
      this.recvLast = -1 // first server box is 0
    } else {
      this.sendKey = keys.s2c
      this.recvKey = keys.c2s
      this.sendAad = AAD_S2C
      this.recvAad = AAD_C2S
      this.sendN = 0
      this.recvLast = 0 // the auth box consumed c2s 0
    }
  }

  /** Seal an arbitrary JSON-serializable message into a box envelope. */
  seal(msg: unknown): BoxMessage {
    const n = this.sendN
    this.sendN += 1
    return {
      type: 'box',
      n,
      ct: sealRaw(this.sendKey, n, this.sendAad, Buffer.from(JSON.stringify(msg), 'utf8')),
    }
  }

  /**
   * Open a received box. Enforces the strictly-increasing counter BEFORE
   * paying decryption. Throws SealedLinkError — callers tear the connection
   * down (loud on attack; the client reconnects with fresh keys).
   */
  open(box: BoxMessage): unknown {
    if (!Number.isSafeInteger(box.n) || box.n < 0) throw new SealedLinkError('malformed')
    if (box.n <= this.recvLast) throw new SealedLinkError('replay')
    const pt = openRaw(this.recvKey, box.n, this.recvAad, box.ct)
    if (!pt) throw new SealedLinkError('tamper')
    // Advance only after a VERIFIED open — a forged counter must not be able
    // to wedge the window shut for the honest sender.
    this.recvLast = box.n
    try {
      return JSON.parse(pt.toString('utf8'))
    } catch {
      throw new SealedLinkError('malformed')
    }
  }
}

// ---------------------------------------------------------------------------
// Bind/downgrade policy helpers (shared by server policy + client fallback).
// ---------------------------------------------------------------------------

/** Is this host loopback-ish (safe for plaintext v2 compat)? */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h === '::1') return true
  if (/^127(\.\d{1,3}){3}$/.test(h)) return true
  // IPv4-mapped IPv6 loopback (::ffff:127.0.0.1).
  if (h.startsWith('::ffff:127.')) return true
  return false
}
