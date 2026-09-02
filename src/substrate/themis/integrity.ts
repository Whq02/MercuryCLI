/* ============================================================================
   THEMIS integrity — SHA-256 content addressing + an HMAC-stamped lockfile.

   Adapted from arXiv:2606.26924 §"content addressing" + §"HMAC-stamped
   lockfile". An enrolled set of trust-relevant config files (MERCURY.md,
   .mercury/settings.json, the wrapper append, …) is content-addressed into
   .mercury/themis/lock.json; the lockfile itself is stamped with HMAC-SHA256
   under a machine-local key so casual/automated corruption of the lockfile is
   detectable too.

   HONEST SCOPE (the paper's own, kept verbatim): a machine-local key that the
   same user can read means this detects ACCIDENTAL or AUTOMATED corruption —
   an npm postinstall rewriting settings, a bad merge mangling MERCURY.md — NOT
   same-user adversarial forgery (whoever can read the key can re-stamp). An
   org-held signing key is the named upgrade path, out of scope here.

   Key placement: <config-home>/themis.key (0600, 32 random bytes hex, created
   on first lock). Config-home, not the repo — the key must not travel with a
   checkout, and every repo on the machine shares one stamping identity.

   Single-token / single-byte edits that Jaccard drift can't see (drift.ts's
   documented gap) are exactly what the exact SHA match here catches — the two
   modules are designed as a pair.
   ============================================================================ */

import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { getMercuryHome } from '../../utils/envUtils.js'
import { themisDir } from './auditChain.js'
import { durableAtomicPublish } from '../durablePublish.js'

export interface LockfileEntry {
  sha256: string
  bytes: number
}

export interface Lockfile {
  version: 1
  createdAt: string
  updatedAt: string
  files: Record<string, LockfileEntry> // repo-relative path → digest
  hmac?: string
}

/** The default enrolled set — the prompt/config surfaces an agent or a rogue
 *  postinstall would most plausibly rewrite. Re-declare via `mercury themis
 *  lock <extra paths…>`: each lock REPLACES the enrolled set with defaults +
 *  the paths named in THAT invocation (this is also the only un-enroll path);
 *  the CLI prints anything a re-lock drops so the narrowing is never silent. */
export const DEFAULT_ENROLLED = [
  'MERCURY.md',
  '.mercury/settings.json',
] as const

export function lockfilePath(cwd: string = process.cwd()): string {
  return join(themisDir(cwd), 'lock.json')
}

function keyPath(): string {
  return join(getMercuryHome(), 'themis.key')
}

async function loadOrCreateKey(): Promise<string> {
  const p = keyPath()
  try {
    const k = (await readFile(p, 'utf8')).trim()
    if (k.length >= 32) return k
  } catch {
    /* create below */
  }
  const fresh = randomBytes(32).toString('hex')
  await mkdir(getMercuryHome(), { recursive: true })
  await writeFile(p, fresh + '\n', { encoding: 'utf8', mode: 0o600 })
  await chmod(p, 0o600).catch(() => {})
  return fresh
}

/** Canonical serialization the HMAC covers: the lockfile minus `hmac`, with
 *  files keyed in sorted order — deterministic across writers. */
export function canonicalLockfile(lock: Omit<Lockfile, 'hmac'>): string {
  const sortedFiles: Record<string, LockfileEntry> = {}
  for (const k of Object.keys(lock.files).sort()) sortedFiles[k] = lock.files[k]!
  return JSON.stringify({
    version: lock.version,
    createdAt: lock.createdAt,
    updatedAt: lock.updatedAt,
    files: sortedFiles,
  })
}

export function stampLockfile(lock: Omit<Lockfile, 'hmac'>, key: string): Lockfile {
  const hmac = createHmac('sha256', key).update(canonicalLockfile(lock)).digest('hex')
  return { ...lock, hmac }
}

async function sha256File(abs: string): Promise<LockfileEntry | null> {
  try {
    const buf = await readFile(abs)
    return { sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length }
  } catch {
    return null
  }
}

/** Enroll (or re-enroll) the given repo-relative paths. Missing files are
 *  skipped with a note — enrolling is an explicit operator act, so we report
 *  rather than fail. Returns the written lockfile. */
export async function enrollLockfile(
  paths: readonly string[] = DEFAULT_ENROLLED,
  cwd: string = process.cwd(),
): Promise<{ lock: Lockfile; enrolled: string[]; missing: string[] }> {
  const key = await loadOrCreateKey()
  let createdAt = new Date().toISOString()
  try {
    const prior = JSON.parse(await readFile(lockfilePath(cwd), 'utf8')) as Lockfile
    if (prior?.createdAt) createdAt = prior.createdAt
  } catch {
    /* first enrollment */
  }
  const files: Record<string, LockfileEntry> = {}
  const enrolled: string[] = []
  const missing: string[] = []
  for (const rel of paths) {
    const entry = await sha256File(join(cwd, rel))
    if (entry) {
      files[rel] = entry
      enrolled.push(rel)
    } else {
      missing.push(rel)
    }
  }
  const lock = stampLockfile(
    { version: 1, createdAt, updatedAt: new Date().toISOString(), files },
    key,
  )
  await durableAtomicPublish(lockfilePath(cwd), JSON.stringify(lock, null, 1))
  return { lock, enrolled, missing }
}

export type LockVerdict =
  | { ok: true; checked: number }
  | { ok: false; kind: 'no-lockfile'; detail: string }
  | { ok: false; kind: 'hmac'; detail: string }
  | {
      ok: false
      kind: 'mismatch'
      detail: string
      mismatched: string[]
      missing: string[]
    }

/** Recompute every enrolled file's digest and the lockfile's HMAC. The install
 *  contract from the paper: a caller in enforce mode should REFUSE to proceed
 *  (surface + require re-approval) on any non-ok verdict. */
export async function verifyLockfile(cwd: string = process.cwd()): Promise<LockVerdict> {
  let lock: Lockfile
  try {
    lock = JSON.parse(await readFile(lockfilePath(cwd), 'utf8')) as Lockfile
  } catch {
    return { ok: false, kind: 'no-lockfile', detail: 'no lockfile enrolled (run: themis lock)' }
  }
  const key = await loadOrCreateKey()
  const { hmac, ...body } = lock
  const expect = createHmac('sha256', key).update(canonicalLockfile(body)).digest('hex')
  if (!hmac || hmac !== expect) {
    return { ok: false, kind: 'hmac', detail: 'lockfile HMAC does not verify — the lockfile itself was altered or the key changed' }
  }
  const mismatched: string[] = []
  const missing: string[] = []
  for (const [rel, entry] of Object.entries(lock.files ?? {})) {
    const now = await sha256File(join(cwd, rel))
    if (!now) missing.push(rel)
    else if (now.sha256 !== entry.sha256) mismatched.push(rel)
  }
  if (mismatched.length || missing.length) {
    return {
      ok: false,
      kind: 'mismatch',
      detail: `content drift vs lockfile: ${[...mismatched.map(m => `${m} (changed)`), ...missing.map(m => `${m} (missing)`)].join(', ')}`,
      mismatched,
      missing,
    }
  }
  return { ok: true, checked: Object.keys(lock.files ?? {}).length }
}

/** Does a lockfile exist? (Cheap boot probe — verify only when enrolled.) */
export async function lockfileExists(cwd: string = process.cwd()): Promise<boolean> {
  try {
    await stat(lockfilePath(cwd))
    return true
  } catch {
    return false
  }
}
