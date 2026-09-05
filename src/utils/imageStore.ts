import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { open, mkdir, readdir, readFile, rm, rmdir, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import { getSessionId } from '../bootstrap/state.js'
import type { PastedContent } from './config/schema.js'
import { logForDebugging } from './debug.js'
import { getMercuryHome } from './envUtils.js'


const MAX_TRACKED_PATHS = 200

const storedPaths = new Map<number, string>()

function cacheBaseDir(): string {
  return join(getMercuryHome(), 'image-cache')
}

function sessionCacheDir(): string {
  return join(cacheBaseDir(), getSessionId())
}

function imagePathFor(content: PastedContent): string {
  const ext = content.mediaType?.split('/')[1] || 'png'
  return join(sessionCacheDir(), `${content.id}.${ext}`)
}

function remember(id: number, path: string): void {
  while (storedPaths.size >= MAX_TRACKED_PATHS) {
    const oldest = storedPaths.keys().next()
    if (oldest.done) break
    storedPaths.delete(oldest.value)
  }
  storedPaths.set(id, path)
}

export function cacheImagePath(content: PastedContent): string | null {
  if (content.type !== 'image') return null
  const path = imagePathFor(content)
  remember(content.id, path)
  return path
}

export async function storeImage(content: PastedContent): Promise<string | null> {
  if (content.type !== 'image') return null
  const path = imagePathFor(content)
  try {
    await mkdir(sessionCacheDir(), { recursive: true })
    const handle = await open(path, 'w', 0o600)
    try {
      await handle.writeFile(Buffer.from(content.content, 'base64'))
      await handle.sync()
    } finally {
      await handle.close()
    }
    remember(content.id, path)
    logForDebugging(`imageStore: stored image ${content.id} at ${path}`)
    return path
  } catch (err) {
    logForDebugging(`imageStore: failed to store image ${content.id}: ${String(err)}`)
    return null
  }
}

export async function storeImages(pastedContents: Record<number, PastedContent>): Promise<Map<number, string>> {
  const result = new Map<number, string>()
  for (const content of Object.values(pastedContents)) {
    if (content.type !== 'image') continue
    const path = await storeImage(content)
    if (path) result.set(content.id, path)
  }
  return result
}

export function getStoredImagePath(imageId: number): string | null {
  return storedPaths.get(imageId) ?? null
}

export function storedImageState(imageId: number): { path: string; present: boolean } | null {
  const path = storedPaths.get(imageId)
  if (path === undefined) return null
  return { path, present: existsSync(path) }
}

export function missingStoredImageWords(imageId: number, path: string): string {
  return `[Image #${imageId}] file missing: ${path} — paste the image again`
}

export function clearStoredImagePaths(): void {
  storedPaths.clear()
}


export const STORED_IMAGE_SOURCE_TYPE = 'mercury-stored-image'

export interface StoredImageRefBlock {
  type: 'image'
  source: {
    type: typeof STORED_IMAGE_SOURCE_TYPE
    path: string
    media_type: string
    sha256: string
    imageId: number
  }
}

export function storedImageRefBlock(content: PastedContent): StoredImageRefBlock | null {
  if (content.type !== 'image' || !content.content) return null
  const path = storedPaths.get(content.id) ?? imagePathFor(content)
  try {
    const bytes = Buffer.from(content.content, 'base64')
    const onDisk = statSync(path)
    if (!onDisk.isFile() || onDisk.size !== bytes.length) return null
    return {
      type: 'image',
      source: {
        type: STORED_IMAGE_SOURCE_TYPE,
        path,
        media_type: content.mediaType ?? 'image/png',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        imageId: content.id,
      },
    }
  } catch {
    return null
  }
}

export function isStoredImageRef(block: unknown): block is StoredImageRefBlock {
  if (!block || typeof block !== 'object') return false
  const candidate = block as { type?: unknown; source?: { type?: unknown; path?: unknown; sha256?: unknown; media_type?: unknown } }
  return (
    candidate.type === 'image' &&
    !!candidate.source &&
    typeof candidate.source === 'object' &&
    candidate.source.type === STORED_IMAGE_SOURCE_TYPE &&
    typeof candidate.source.path === 'string' &&
    typeof candidate.source.sha256 === 'string' &&
    typeof candidate.source.media_type === 'string'
  )
}

export async function readStoredImageRef(
  block: StoredImageRefBlock,
): Promise<{ kind: 'image'; block: { type: 'image'; source: { type: 'base64'; media_type: string; data: string } } } | { kind: 'missing'; words: string }> {
  const root = resolve(cacheBaseDir()) + sep
  const path = resolve(block.source.path)
  if (!path.startsWith(root)) {
    return { kind: 'missing', words: `[Image #${block.source.imageId}] refused: ${block.source.path} is not in the image store` }
  }
  try {
    const bytes = await readFile(path)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== block.source.sha256) {
      return { kind: 'missing', words: `[Image #${block.source.imageId}] file changed since it was pasted: ${path} — paste the image again` }
    }
    return {
      kind: 'image',
      block: { type: 'image', source: { type: 'base64', media_type: block.source.media_type, data: bytes.toString('base64') } },
    }
  } catch {
    return { kind: 'missing', words: missingStoredImageWords(block.source.imageId, path) }
  }
}


export async function cleanupOldImageCaches(cutoff: Date): Promise<void> {
  const base = cacheBaseDir()
  const current = getSessionId()
  let entries: string[]
  try {
    entries = await readdir(base)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry === current) continue
    const target = join(base, entry)
    try {
      if ((await newestMtime(target)) >= cutoff.getTime()) continue
      await rm(target, { recursive: true, force: true })
      logForDebugging(`imageStore: removed old image cache ${target}`)
    } catch {
    }
  }
  try {
    const remaining = await readdir(base)
    if (remaining.length === 0) await rmdir(base)
  } catch {
  }
}

async function newestMtime(dir: string): Promise<number> {
  const own = (await stat(dir)).mtimeMs
  let newest = own
  try {
    for (const name of await readdir(dir)) {
      try {
        newest = Math.max(newest, (await stat(join(dir, name))).mtimeMs)
      } catch {
      }
    }
  } catch {
  }
  return newest
}
