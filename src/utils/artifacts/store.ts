


import { flagEnvLoose } from '../../substrate/flagRegistry.js'
import {
  createHash,
  randomBytes,
} from 'node:crypto'
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

const MB = 1024 * 1024
function envInt(name: string, fallback: number): number {
  const n = parseInt(flagEnvLoose(name) ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
const MAX_CONTENT_BYTES = envInt('MERCURY_ARTIFACT_MAX_MB', 8) * MB

const META_SUFFIX = '.meta.json'

const DEFAULT_KEEP = envInt('MERCURY_ARTIFACT_KEEP', 200)

const ORPHAN_GRACE_MS = 60_000


function slug(s: string, fallback: string): string {
  const out = String(s ?? '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120)
  return out || fallback
}

export function scopeSlugForDir(dir: string): string {
  const d = String(dir ?? '')
  const hash = createHash('sha256').update(d).digest('hex').slice(0, 8)
  return slug(d, 'default').slice(0, 80) + '-' + hash
}

export function getArtifactsRootDir(): string {
  return join(getMercuryHome(), 'artifacts')
}

export function getArtifactScopeDir(scope: string): string {
  return join(getArtifactsRootDir(), slug(scope, 'default'))
}


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
  if (typeof v === 'string') return redactSecrets(v)
  return v
}

export function redactMetadata(meta: unknown): Record<string, unknown> {
  try {
    if (!isPlainObject(meta)) return {}
    const red = redactValue(meta, false)
    return isPlainObject(red) ? red : {}
  } catch {
    return {}
  }
}


export interface ArtifactMeta {
  id: string
  name: string
  kind: string
  createdAt: string
  sizeBytes: number
  sha256: string
  truncated?: boolean
  metadata: Record<string, unknown>
}

export interface StoreArtifactInput {
  scope: string
  name: string
  content: string
  kind?: string
  metadata?: Record<string, unknown>
}

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
    content = redactSecrets(content)
    let truncated = false
    let buf = Buffer.from(content, 'utf8')
    if (buf.length > MAX_CONTENT_BYTES) {
      buf = buf.subarray(0, MAX_CONTENT_BYTES)
      content = buf.toString('utf8')
      buf = Buffer.from(content, 'utf8')
      truncated = true
    }

    const sha = sha256Hex(buf)
    const sha8 = sha.slice(0, 8)
    const dir = getArtifactScopeDir(scope)
    await mkdir(dir, { recursive: true })

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

    const metaPath = join(dir, `${id}${META_SUFFIX}`)
    try {
      await durableAtomicPublish(metaPath, JSON.stringify(meta, null, 2), { mode: 0o600 })
    } catch {
      await rm(blobPath, { force: true }).catch(() => {})
      return { id: null, path: null }
    }

    try {
      await pruneArtifacts(scope, DEFAULT_KEEP)
    } catch {
    }

    return { id, path: blobPath }
  } catch {
    return { id: null, path: null }
  }
}

export async function listArtifacts(scope: string): Promise<ArtifactMeta[]> {
  try {
    const dir = getArtifactScopeDir(scope)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return []
    }
    const metas: ArtifactMeta[] = []
    for (const f of names) {
      if (!f.endsWith(META_SUFFIX)) continue
      try {
        const raw = await readFile(join(dir, f), 'utf8')
        const parsed = JSON.parse(raw) as unknown
        if (isValidMeta(parsed)) metas.push(parsed)
      } catch {
      }
    }
    metas.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    return metas
  } catch {
    return []
  }
}

function isValidMeta(v: unknown): v is ArtifactMeta {
  return (
    isPlainObject(v) &&
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    typeof v.name === 'string' &&
    typeof v.createdAt === 'string'
  )
}

export interface RetrievedArtifact {
  meta: ArtifactMeta
  content: string
}

export async function getArtifact(
  scope: string,
  id: string,
): Promise<RetrievedArtifact | null> {
  try {
    if (typeof id !== 'string' || !id) return null
    if (!/^[A-Za-z0-9._-]+$/.test(id) || id.includes('..')) return null
    const dir = getArtifactScopeDir(scope)
    const metaPath = join(dir, `${id}${META_SUFFIX}`)
    const blobPath = join(dir, id)
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as unknown
    if (!isValidMeta(meta)) return null
    const content = await readFile(blobPath, 'utf8')
    return { meta, content }
  } catch {
    return null
  }
}

export async function pruneArtifacts(scope: string, keepN: number): Promise<void> {
  try {
    const keep =
      Number.isFinite(keepN) && keepN > 0 ? Math.floor(keepN) : DEFAULT_KEEP
    const dir = getArtifactScopeDir(scope)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return
    }

    const ids = new Map<string, { hasBlob: boolean; hasMeta: boolean; mtime: number }>()
    for (const f of names) {
      if (f.startsWith('.')) continue
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

    const now = Date.now()
    const complete: { id: string; mtime: number }[] = []
    for (const [id, info] of ids) {
      if (info.hasBlob && info.hasMeta) complete.push({ id, mtime: info.mtime })
      else if (now - info.mtime > ORPHAN_GRACE_MS) await remove(id)
    }

    if (complete.length <= keep) return
    complete.sort((a, b) => b.mtime - a.mtime)
    for (const { id } of complete.slice(keep)) await remove(id)
  } catch {
  }
}
