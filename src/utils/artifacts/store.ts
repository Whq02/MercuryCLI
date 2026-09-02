/* ============================================================================
   artifacts/store — the ARTIFACTS CHANNEL for Mercury.
   ----------------------------------------------------------------------------
   Autonomous daemon / fleet runs PRODUCE outputs (a final report, a generated
   file, a run summary) that today are captured only ephemerally — the daemon
   reads a child's stdout, feeds it to the loop-brake / handoff summary, then
   drops it. This module is the missing DURABLE channel: a run can PERSIST a
   named artifact + metadata, and a LATER session / agent can LIST + RETRIEVE it
   — closing the autonomy loop (produce → persist → recall).

   Layout (under the Mercury config home, honoring MERCURY_CONFIG_DIR):
     <configHome>/artifacts/<scope>/<id>            ← the content blob
     <configHome>/artifacts/<scope>/<id>.meta.json  ← the sidecar metadata

   The `<id>` is content-addressed-ish: `<ts>-<sha8>` — the wall-clock prefix
   keeps ids sortable + collision-spaced; the sha8 ties the id to the content so
   two identical writes in the same ms still differ only by an O_EXCL retry. The
   sidecar carries {id, name, kind, createdAt, sizeBytes, sha256, metadata}.

   The discipline: atomic, size-capped,
   self-pruned, secret-refusing — with the observability/invocationTrace config-
   home + redaction idiom; single source of truth for the artifact dir.

   DEFENSIVE BY CONSTRUCTION: every public entry point is wrapped so it NEVER
   throws — storeArtifact returns a null id on failure, listArtifacts returns []
   on a missing/locked dir, getArtifact returns null. Nothing here runs unless a
   caller invokes it (the store is INERT by default); the daemon's writer is
   separately env-gated. Metadata is secret-redacted before it lands on disk.
   ============================================================================ */

import { flagEnvLoose } from '../../substrate/flagRegistry.js'
import {
  createHash,
  randomBytes,
} from 'node:crypto'
// ASYNC fs throughout (reactive-substrate Phase 1): this store used sync fs,
// and the daemon calls it from the same event loop that serves the control
// socket — a slow disk stalled every RPC. All entry points are now async.
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { getMercuryHome } from '../envUtils.js'
import { redactSecrets } from '../secrets/secretScanner.js'
import { durableAtomicPublish } from '../../substrate/durablePublish.js'

/** Hard ceiling on a single artifact's content. Anything larger is truncated
 *  (head-kept) before storage — an artifact is a recallable SUMMARY/OUTPUT, not
 *  a bulk dump; this bounds the store and the read path. Override via env. */
const MB = 1024 * 1024
function envInt(name: string, fallback: number): number {
  const n = parseInt(flagEnvLoose(name) ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
const MAX_CONTENT_BYTES = envInt('MERCURY_ARTIFACT_MAX_MB', 8) * MB

/** Sidecar suffix. The content blob is `<id>`; its metadata is `<id>.meta.json`. */
const META_SUFFIX = '.meta.json'

/** Default retention: keep this many newest artifacts per scope after a store. */
const DEFAULT_KEEP = envInt('MERCURY_ARTIFACT_KEEP', 200)

/** Grace window before an "orphan" (blob without sidecar, or vice-versa) is
 *  reaped. A store writes the blob, THEN the sidecar (temp+rename), so there's a
 *  brief blob-without-sidecar window; under concurrent writes (a daemon at
 *  MERCURY_DAEMON_MAX_INFLIGHT) one store's prune must NOT reap another store's
 *  in-flight blob. Only reap orphans older than this. */
const ORPHAN_GRACE_MS = 60_000

/* ── scope / id slugging ────────────────────────────────────────────────────
   A scope is a filesystem-safe directory name. Both the daemon (which keys off
   its scheduling dir) and the read-side tool (which keys off the session cwd)
   route through scopeSlugForDir so they land in the SAME directory — one source
   of truth for the slug, never a re-derived/drifting copy. */

/** Collapse any string to a safe `[A-Za-z0-9._-]` slug (bounded length). */
function slug(s: string, fallback: string): string {
  const out = String(s ?? '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120)
  return out || fallback
}

/**
 * Stable, filesystem-safe scope name for a project directory. Mirrors the
 * daemon's handoff-dir slugging so the daemon's writes and a session's reads
 * agree on the scope without a shared constant.
 */
export function scopeSlugForDir(dir: string): string {
  // Collision-resistant (#11): slug() truncates AND is not injective ("/a/b" and
  // "/a_b" both collapse to "a_b"; long paths can share their first 120 slug
  // chars), so two DISTINCT project dirs could map to ONE scope and cross-leak
  // artifacts. Suffix a short hash of the FULL absolute dir so distinct dirs
  // always get distinct scopes. Both the daemon writer and the ArtifactsList
  // reader call THIS, so they still agree on the scope. (The hash suffix is
  // slug-safe, so it survives storeArtifact's / getArtifactScopeDir's re-slug.)
  const d = String(dir ?? '')
  const hash = createHash('sha256').update(d).digest('hex').slice(0, 8)
  return slug(d, 'default').slice(0, 80) + '-' + hash
}

/** The root artifacts dir under the config home (honors MERCURY_CONFIG_DIR). */
export function getArtifactsRootDir(): string {
  return join(getMercuryHome(), 'artifacts')
}

/** Absolute dir for a single scope. Exported so a viewer reads the SAME path. */
export function getArtifactScopeDir(scope: string): string {
  return join(getArtifactsRootDir(), slug(scope, 'default'))
}

/* ── secret redaction (mirrors observability/invocationTrace) ────────────────
   Any value under a sensitive-looking key in `metadata` becomes '[redacted]'
   before it is written to the sidecar — an artifact's metadata is recalled
   verbatim by a later agent, so a key/token landing there is a durable leak.
   Pure, never throws. */

const SENSITIVE_KEY =
  /(api[-_]?key|secret|token|password|passwd|credential|authorization|bearer|cookie|private[-_]?key|access[-_]?key|client[-_]?secret)/i
const REDACTED = '[redacted]'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v)
}

function redactValue(v: unknown, parentSensitive: boolean): unknown {
  if (Array.isArray(v)) return v.map(el => redactValue(el, parentSensitive))
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactValue(v[k], false)
    }
    return out
  }
  if (parentSensitive) return REDACTED
  // VALUE-level scrub (#9): a secret sitting in a string value under a
  // NON-sensitive key (e.g. {note: "token=ghp_..."}) would otherwise persist
  // verbatim. Run the value through the secret scanner so the VALUE is redacted
  // even when the KEY looks innocent.
  if (typeof v === 'string') return redactSecrets(v)
  return v
}

/**
 * Deep-redact a metadata object. Non-object input folds to {}. Pure, never
 * throws — redaction can never fail, so an artifact is always storable.
 */
export function redactMetadata(meta: unknown): Record<string, unknown> {
  try {
    if (!isPlainObject(meta)) return {}
    const red = redactValue(meta, false)
    return isPlainObject(red) ? red : {}
  } catch {
    return {}
  }
}

/* ── the artifact shape ──────────────────────────────────────────────────── */

/** The sidecar metadata persisted alongside an artifact's content blob. */
export interface ArtifactMeta {
  /** `<ts>-<sha8>` — sortable + content-tied. The retrieval key. */
  id: string
  /** Caller-supplied logical name (slug-safe echo of the requested name). */
  name: string
  /** Producer category, e.g. 'daemon-run'. Free-form, defaults to 'output'. */
  kind: string
  /** ISO timestamp the artifact was stored. */
  createdAt: string
  /** Byte length of the stored content (post-truncation). */
  sizeBytes: number
  /** SHA-256 of the stored content (hex). */
  sha256: string
  /** True when the content was truncated to the size ceiling before storage. */
  truncated?: boolean
  /** Redacted free-form metadata. */
  metadata: Record<string, unknown>
}

/** Input to {@link storeArtifact}. */
export interface StoreArtifactInput {
  /** Logical scope (project slug, team name, …). Routed through the slugger. */
  scope: string
  /** Logical name for the artifact. */
  name: string
  /** The content to persist (string). */
  content: string
  /** Producer category. Defaults to 'output'. */
  kind?: string
  /** Free-form metadata — secret-redacted before write. */
  metadata?: Record<string, unknown>
}

/** Result of a successful store; `id` is null when the store failed (no throw). */
export interface StoreArtifactResult {
  id: string | null
  path: string | null
}

function nowISO(): string {
  return new Date().toISOString()
}

function sha256Hex(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Persist a content artifact + its metadata sidecar under <scope>. Returns
 * `{ id, path }` (id/path null on any failure — NEVER throws). The content is
 * truncated to the size ceiling first. The blob is written O_EXCL so a same-id
 * collision is retried rather than clobbering an existing artifact; the sidecar
 * is written atomically (temp + rename) so a half-written meta is never read.
 *
 * INERT by default: nothing calls this unless a producer (the env-gated daemon
 * writer, or a tool) invokes it.
 */
export async function storeArtifact(
  input: StoreArtifactInput,
): Promise<StoreArtifactResult> {
  try {
    if (!input || typeof input !== 'object') return { id: null, path: null }
    const scope = slug(input.scope, 'default')
    const name = slug(input.name, 'artifact')
    const kind =
      typeof input.kind === 'string' && input.kind.trim()
        ? slug(input.kind, 'output')
        : 'output'

    let content =
      typeof input.content === 'string' ? input.content : String(input.content ?? '')
    // SECRET REDACTION (#8): the content BLOB is persisted to disk and recalled
    // by later sessions/agents — scrub secret values BEFORE hashing/writing so a
    // key/token in a run's stdout never lands unredacted on disk. (The store
    // must not redact only metadata KEYS while the blob stays raw — that makes the
    // claimed "secret-redacted" invariant false for the content.)
    content = redactSecrets(content)
    let truncated = false
    // Bound the stored blob (head-kept) — an artifact is a recallable output,
    // not a bulk dump. Byte-accurate truncation via Buffer.
    let buf = Buffer.from(content, 'utf8')
    if (buf.length > MAX_CONTENT_BYTES) {
      buf = buf.subarray(0, MAX_CONTENT_BYTES)
      content = buf.toString('utf8')
      buf = Buffer.from(content, 'utf8') // re-encode (a multibyte cut shrinks it)
      truncated = true
    }

    const sha = sha256Hex(buf)
    const sha8 = sha.slice(0, 8)
    const dir = getArtifactScopeDir(scope)
    await mkdir(dir, { recursive: true })

    // Content-addressed-ish id: sortable ts prefix + content sha8. On the rare
    // same-ms same-content collision, O_EXCL ('wx') fails and we retry with a
    // random suffix — the write is lock-safe (never clobbers an existing artifact).
    let id = `${Date.now()}-${sha8}`
    let blobPath = join(dir, id)
    let fh: Awaited<ReturnType<typeof open>> | null = null
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fh = await open(blobPath, 'wx', 0o600)
        break
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === 'EEXIST') {
          id = `${Date.now()}-${sha8}-${randomBytes(2).toString('hex')}`
          blobPath = join(dir, id)
          continue
        }
        throw e
      }
    }
    if (fh === null) return { id: null, path: null }
    try {
      await fh.write(buf)
    } finally {
      await fh.close()
    }

    const meta: ArtifactMeta = {
      id,
      name,
      kind,
      createdAt: nowISO(),
      sizeBytes: buf.length,
      sha256: sha,
      ...(truncated ? { truncated: true } : {}),
      metadata: redactMetadata(input.metadata),
    }

    // Atomic sidecar write through the one durable primitive (its failure
    // path cleans its own temp; we still drop the orphan blob).
    const metaPath = join(dir, `${id}${META_SUFFIX}`)
    try {
      await durableAtomicPublish(metaPath, JSON.stringify(meta, null, 2), { mode: 0o600 })
    } catch {
      // Sidecar failed — drop the orphan blob so a metaless blob can't linger.
      await rm(blobPath, { force: true }).catch(() => {})
      return { id: null, path: null }
    }

    // Bound the scope (best-effort, never throws out).
    try {
      await pruneArtifacts(scope, DEFAULT_KEEP)
    } catch {
      /* pruning is best-effort */
    }

    return { id, path: blobPath }
  } catch {
    // Defensive: a store failure must never propagate to the producer.
    return { id: null, path: null }
  }
}

/**
 * List a scope's artifact metadata, NEWEST FIRST. Never throws: a missing /
 * unreadable dir yields []. A junk / half-written sidecar is skipped, not fatal.
 */
export async function listArtifacts(scope: string): Promise<ArtifactMeta[]> {
  try {
    const dir = getArtifactScopeDir(scope)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return [] // missing/unreadable dir ⇒ no artifacts
    }
    const metas: ArtifactMeta[] = []
    for (const f of names) {
      if (!f.endsWith(META_SUFFIX)) continue
      try {
        const raw = await readFile(join(dir, f), 'utf8')
        const parsed = JSON.parse(raw) as unknown
        if (isValidMeta(parsed)) metas.push(parsed)
      } catch {
        // Skip a junk / half-written sidecar — never let one corrupt the list.
      }
    }
    // Newest first. The id's ts prefix sorts, but createdAt is the honest key.
    metas.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    return metas
  } catch {
    return []
  }
}

/** Shape-guard for a parsed sidecar. */
function isValidMeta(v: unknown): v is ArtifactMeta {
  return (
    isPlainObject(v) &&
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    typeof v.name === 'string' &&
    typeof v.createdAt === 'string'
  )
}

/** A retrieved artifact: its metadata + the content blob. */
export interface RetrievedArtifact {
  meta: ArtifactMeta
  content: string
}

/**
 * Retrieve one artifact by id from a scope. Returns null when the id is unknown,
 * malformed (path-traversal guard), or the blob/sidecar can't be read. NEVER
 * throws.
 */
export async function getArtifact(
  scope: string,
  id: string,
): Promise<RetrievedArtifact | null> {
  try {
    if (typeof id !== 'string' || !id) return null
    // Path-traversal guard: an id is the charset-safe `<ts>-<sha8>[-<rand>]`.
    if (!/^[A-Za-z0-9._-]+$/.test(id) || id.includes('..')) return null
    const dir = getArtifactScopeDir(scope)
    const metaPath = join(dir, `${id}${META_SUFFIX}`)
    const blobPath = join(dir, id)
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as unknown
    if (!isValidMeta(meta)) return null
    const content = await readFile(blobPath, 'utf8')
    return { meta, content }
  } catch {
    return null // missing blob/sidecar or unreadable ⇒ not retrievable
  }
}

/**
 * Retention: keep the `keepN` NEWEST artifacts in a scope, delete the rest
 * (blob + sidecar together). A blob with no sidecar (or vice-versa) is also
 * swept as orphaned. Never throws; a non-positive keepN is treated as "keep
 * default" so a bad caller can't wipe the store.
 */
export async function pruneArtifacts(scope: string, keepN: number): Promise<void> {
  try {
    const keep =
      Number.isFinite(keepN) && keepN > 0 ? Math.floor(keepN) : DEFAULT_KEEP
    const dir = getArtifactScopeDir(scope)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return // missing/unreadable dir ⇒ nothing to prune
    }

    // Group by id: an entry has a blob and/or a sidecar.
    const ids = new Map<string, { hasBlob: boolean; hasMeta: boolean; mtime: number }>()
    for (const f of names) {
      if (f.startsWith('.')) continue // skip in-flight temp sidecars
      const isMeta = f.endsWith(META_SUFFIX)
      const id = isMeta ? f.slice(0, -META_SUFFIX.length) : f
      if (!id) continue
      let mtime = 0
      try {
        mtime = (await stat(join(dir, f))).mtimeMs
      } catch {
        continue
      }
      const cur = ids.get(id) ?? { hasBlob: false, hasMeta: false, mtime: 0 }
      if (isMeta) cur.hasMeta = true
      else cur.hasBlob = true
      cur.mtime = Math.max(cur.mtime, mtime)
      ids.set(id, cur)
    }

    const remove = async (id: string) => {
      await rm(join(dir, id), { force: true }).catch(() => {})
      await rm(join(dir, `${id}${META_SUFFIX}`), { force: true }).catch(() => {})
    }

    // Sweep orphans (a blob missing its sidecar, or vice-versa) — but ONLY once
    // they're older than the grace window, so a concurrent in-flight write (whose
    // blob exists before its sidecar is renamed in) is never reaped (#10).
    const now = Date.now()
    const complete: { id: string; mtime: number }[] = []
    for (const [id, info] of ids) {
      if (info.hasBlob && info.hasMeta) complete.push({ id, mtime: info.mtime })
      else if (now - info.mtime > ORPHAN_GRACE_MS) await remove(id)
      // else: a young orphan — likely an in-flight concurrent write; leave it.
    }

    // Keep the newest `keep`; delete the older surplus.
    if (complete.length <= keep) return
    complete.sort((a, b) => b.mtime - a.mtime)
    for (const { id } of complete.slice(keep)) await remove(id)
  } catch {
    /* retention is best-effort; never throws out. */
  }
}
