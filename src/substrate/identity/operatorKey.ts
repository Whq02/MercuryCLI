/**
 * The operator key — an Ed25519 keypair born ONCE in the config home; the
 * operator's principal id derives from its PUBLIC half (ledger L27: "good
 * enough that it's me" on this box — deliberately not a machine-switch
 * survivor; a friend's box has its own key).
 *
 * Laws (scripts/operator-identity/prove-operator-identity.ts):
 *   · BORN ONCE — first need creates `<config-home>/identity/operator.json`
 *     (dir 0700, file 0600) with an EXCLUSIVE create, so two first-boots
 *     racing the birth converge on ONE key (the loser reads the winner's);
 *     an existing file is always adopted, never re-minted.
 *   · NEVER IN A PROJECT — the path derives only from the one config-home
 *     resolver; the cwd is never consulted.
 *   · NEVER SYNCED BY US — nothing copies or exports the private half.
 *   · PROVIDER-NEUTRAL BY CONSTRUCTION — the key is generated locally and
 *     carries no account material.
 *   · LOUD ON DAMAGE — an unreadable or corrupt key file throws with the
 *     path and the recovery, never silently mints a second identity (a
 *     silent re-mint would orphan every record keyed by the lost key; the
 *     adoption law only bridges the PRE-KEY hash generations).
 *
 * Everything here is synchronous by contract: operatorPrincipal() is called
 * from synchronous seams (the local author resolution, the room ACL), so the
 * key must resolve without an event-loop turn. The birth cost (~ms, keygen +
 * one fsynced write) is paid once per home.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto'
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { getMercuryHome } from '../../utils/envUtils.js'

export const OPERATOR_KEY_VERSION = 1 as const

/** The on-disk shape (JWK-style raw fields, base64url of 32 bytes each). */
export interface OperatorKeyFileV1 {
  v: typeof OPERATOR_KEY_VERSION
  alg: 'Ed25519'
  createdAt: number
  publicKey: string
  privateKey: string
}

export interface OperatorKey {
  /** `op-` + sha256(raw public key)[0:12] — the operator principal id. The
   *  12-hex tail matches the pre-key hash generation's SHAPE AND LENGTH
   *  exactly, so the record re-key is size-preserving (a rewritten room
   *  segment keeps every byte offset). */
  id: string
  publicKeyRaw: Buffer
  publicKey: KeyObject
  privateKey: KeyObject
  createdAt: number
}

/** Where the key lives — only ever under the config home, never a project. */
export function operatorKeyPath(home: string = getMercuryHome()): string {
  return join(home, 'identity', 'operator.json')
}

/** Derive the principal id from a raw 32-byte Ed25519 public key. */
export function deriveOperatorIdFromPublicKey(publicKeyRaw: Buffer): string {
  return `op-${createHash('sha256').update(publicKeyRaw).digest('hex').slice(0, 12)}`
}

const keyByHome = new Map<string, OperatorKey>()

/** TEST-ONLY: forget the per-home memo (provers that re-home mid-run). */
export function _resetOperatorKeyMemoForTesting(): void {
  keyByHome.clear()
}

function corruptKeyError(path: string, cause: unknown): Error {
  return new Error(
    `[identity] the operator identity key at ${path} is unreadable or corrupt (${cause instanceof Error ? cause.message : String(cause)}). ` +
      'This file IS the operator identity: restore it from a backup, or delete it to mint a NEW identity — ' +
      'records keyed by a lost key are re-owned only through the legacy adoption law, never by a silent re-mint.',
  )
}

function parseKeyFile(path: string, raw: string): OperatorKey {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw corruptKeyError(path, e)
  }
  const f = parsed as Partial<OperatorKeyFileV1> | null
  if (
    !f ||
    f.v !== OPERATOR_KEY_VERSION ||
    f.alg !== 'Ed25519' ||
    typeof f.publicKey !== 'string' ||
    typeof f.privateKey !== 'string'
  ) {
    throw corruptKeyError(path, 'not a v1 Ed25519 key file')
  }
  const publicKeyRaw = Buffer.from(f.publicKey, 'base64url')
  if (publicKeyRaw.length !== 32) throw corruptKeyError(path, 'public key is not 32 bytes')
  let publicKey: KeyObject
  let privateKey: KeyObject
  try {
    publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: f.publicKey }, format: 'jwk' })
    privateKey = createPrivateKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: f.publicKey, d: f.privateKey },
      format: 'jwk',
    })
  } catch (e) {
    throw corruptKeyError(path, e)
  }
  return {
    id: deriveOperatorIdFromPublicKey(publicKeyRaw),
    publicKeyRaw,
    publicKey,
    privateKey,
    createdAt: typeof f.createdAt === 'number' ? f.createdAt : 0,
  }
}

/** Owner-only floor for the key file — only ever CLEARS group/other bits. */
function guardKeyFileMode(path: string): void {
  if (process.platform === 'win32') return
  try {
    const mode = statSync(path).mode & 0o777
    if ((mode & 0o077) !== 0) chmodSync(path, mode & 0o700)
  } catch {
    // Best-effort privacy floor — the read path decides readability.
  }
}

/** Bounded synchronous pause (the birth-race read window is sub-millisecond;
 *  three beats cover it with margin). */
function pauseMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function readOrBirthKey(path: string): OperatorKey {
  let lastCause: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    // Read an existing key.
    let raw: string | null = null
    try {
      raw = readFileSync(path, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw corruptKeyError(path, e)
    }
    if (raw !== null) {
      guardKeyFileMode(path)
      try {
        return parseKeyFile(path, raw)
      } catch (e) {
        // A racing winner's write() is one syscall over ~300 bytes, so a torn
        // read is nearly impossible — but bounded patience beats a wrong loud
        // throw. Persistent damage still throws.
        lastCause = e
        pauseMs(30)
        continue
      }
    }
    // Birth: exclusive create so exactly one process mints the key.
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const jwk = privateKey.export({ format: 'jwk' }) as { x?: string; d?: string }
    if (typeof jwk.x !== 'string' || typeof jwk.d !== 'string') {
      throw new Error('[identity] Ed25519 keygen produced no JWK material (runtime defect)')
    }
    void publicKey
    const file: OperatorKeyFileV1 = {
      v: OPERATOR_KEY_VERSION,
      alg: 'Ed25519',
      createdAt: Date.now(),
      publicKey: jwk.x,
      privateKey: jwk.d,
    }
    const contents = JSON.stringify(file, null, 2) + '\n'
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    let fd: number
    try {
      fd = openSync(path, 'wx', 0o600)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue // the sibling won — read theirs
      throw corruptKeyError(path, e)
    }
    try {
      const buf = Buffer.from(contents, 'utf8')
      let off = 0
      while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    return parseKeyFile(path, contents)
  }
  throw corruptKeyError(path, lastCause ?? 'unreadable after bounded retries')
}

/**
 * The operator key for the CURRENT config home — read, or born on first
 * need. Memoized per resolved home (a prover that re-homes mid-process gets
 * that home's own key).
 */
export function ensureOperatorKey(): OperatorKey {
  const home = getMercuryHome()
  const cached = keyByHome.get(home)
  if (cached) return cached
  const key = readOrBirthKey(operatorKeyPath(home))
  keyByHome.set(home, key)
  return key
}

/** The keyed operator principal id (`op-` + 12 hex of the public key). */
export function operatorKeyId(): string {
  return ensureOperatorKey().id
}

/** A COPY of the raw 32-byte public key (safe to hand to views/wires). */
export function operatorPublicKeyRaw(): Buffer {
  return Buffer.from(ensureOperatorKey().publicKeyRaw)
}

/** Sign bytes as the operator (Ed25519, no digest parameter by design). */
export function signAsOperator(data: Buffer | string): Buffer {
  const key = ensureOperatorKey()
  return cryptoSign(null, typeof data === 'string' ? Buffer.from(data, 'utf8') : data, key.privateKey)
}

/**
 * Verify an operator signature. With `publicKeyRaw` absent the CURRENT
 * home's key verifies (self-check); a foreign frame verifies against the
 * raw public key its author advertised. Never throws — malformed material
 * is a refusal, not a crash.
 */
export function verifyOperatorSignature(
  data: Buffer | string,
  signature: Buffer,
  publicKeyRaw?: Buffer,
): boolean {
  try {
    const pub = publicKeyRaw
      ? createPublicKey({
          key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKeyRaw).toString('base64url') },
          format: 'jwk',
        })
      : ensureOperatorKey().publicKey
    return cryptoVerify(
      null,
      typeof data === 'string' ? Buffer.from(data, 'utf8') : data,
      pub,
      signature,
    )
  } catch {
    return false
  }
}
