
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
  type Stats,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { getMercuryHome } from '../../environment/envUtils.js'
import { errorMessage, getErrnoCode, isENOENT } from '../../errors/errors.js'
import { logError } from '../../logs/errorLog.js'
import { posixFileModesApply } from '../../host-os/files.js'
import { passedOver } from '../../errors/passedOver.js'
import { sleepSync } from '../../async/timers.js'

const OPERATOR_KEY_VERSION = 1 as const

interface OperatorKeyFileV1 {
  v: typeof OPERATOR_KEY_VERSION
  alg: 'Ed25519'
  createdAt: number
  publicKey: string
  privateKey: string
}

interface OperatorKey {
  id: string
  publicKeyRaw: Buffer
  publicKey: KeyObject
  privateKey: KeyObject
  createdAt: number
}

export function operatorKeyPath(home: string = getMercuryHome()): string {
  return join(home, 'identity', 'operator.json')
}

function deriveOperatorIdFromPublicKey(publicKeyRaw: Buffer): string {
  return `op-${createHash('sha256').update(publicKeyRaw).digest('hex').slice(0, 12)}`
}

const keyByHome = new Map<string, OperatorKey>()

export function _resetOperatorKeyMemoForTesting(): void {
  keyByHome.clear()
}

function corruptKeyError(path: string, cause: unknown): Error {
  return new Error(
    `[identity] the operator identity key at ${path} is unreadable or corrupt (${cause instanceof Error ? cause.message : String(cause)}). ` +
      'This file IS the operator identity: restore it from a backup, or delete it to mint a NEW identity — ' +
      'records keyed by a lost key stay with that key, never re-owned by a silent re-mint.',
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

function guardKeyFileMode(path: string): void {
  if (!posixFileModesApply()) return
  let stats: Stats
  try {
    stats = statSync(path)
  } catch (e) {
    if (!isENOENT(e)) logError(new Error(`[identity] the mode of the operator identity key at ${path} could not be checked (${getErrnoCode(e) ?? errorMessage(e)}), so the key is used as it was read`))
    return
  }
  const mode = stats.mode & 0o777
  if ((mode & 0o077) === 0) return
  try {
    chmodSync(path, mode & 0o700)
  } catch (e) {
    const code = getErrnoCode(e) ?? errorMessage(e)
    if (stats.uid !== process.getuid?.()) {
      throw new Error(`[identity] the operator identity key at ${path} belongs to another user and could not be made private (${code}) — make the file yours and run: chmod 600 ${path}, or restore your own key from a backup`)
    }
    logError(new Error(`[identity] the operator identity key at ${path} could not be made private (${code}): its filesystem takes no file mode, so other users of this machine may read it`))
  }
}

function pauseMs(ms: number): void {
  sleepSync(ms)
}

function readOrBirthKey(path: string): OperatorKey {
  let lastCause: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
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
        lastCause = e
        pauseMs(30)
        continue
      }
    }
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
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue
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

export function ensureOperatorKey(): OperatorKey {
  const home = getMercuryHome()
  const cached = keyByHome.get(home)
  if (cached) return cached
  const key = readOrBirthKey(operatorKeyPath(home))
  keyByHome.set(home, key)
  return key
}

export function operatorKeyId(): string {
  return ensureOperatorKey().id
}

export function operatorPublicKeyRaw(): Buffer {
  return Buffer.from(ensureOperatorKey().publicKeyRaw)
}

export function signAsOperator(data: Buffer | string): Buffer {
  const key = ensureOperatorKey()
  return cryptoSign(null, typeof data === 'string' ? Buffer.from(data, 'utf8') : data, key.privateKey)
}

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
  } catch (error) {
    passedOver(error)
    return false
  }
}
