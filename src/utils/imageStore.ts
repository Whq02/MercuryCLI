import { open, mkdir, readdir, rm, rmdir } from 'node:fs/promises'
import { join } from 'node:path'

import { getSessionId } from '../bootstrap/state.js'
import type { PastedContent } from './config/schema.js'
import { logForDebugging } from './debug.js'
import { getMercuryHome } from './envUtils.js'

/**
 * Pasted images persisted to a per-session on-disk cache
 * (`<home>/image-cache/<session id>/<image id>.<ext>`), plus reaping of old
 * sessions' caches. A paste must never fail the turn: nothing here throws.
 */

const MAX_TRACKED_PATHS = 200

/** Insertion-ordered; the oldest insertion end is evicted first. */
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

/** Computes and records the path without touching the filesystem (the composer shows it immediately). */
export function cacheImagePath(content: PastedContent): string | null {
  if (content.type !== 'image') return null
  const path = imagePathFor(content)
  remember(content.id, path)
  return path
}

/** Writes with mode 0600, decoding base64, flushed to durable storage; the handle is closed in all cases. */
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

/** Every image entry; entries that failed are skipped. */
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

export function clearStoredImagePaths(): void {
  storedPaths.clear()
}

/** Removes every entry that is not the current session (recursively, forcefully), then the base directory if empty. Every level swallows its own errors. */
export async function cleanupOldImageCaches(): Promise<void> {
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
      await rm(target, { recursive: true, force: true })
      logForDebugging(`imageStore: removed old image cache ${target}`)
    } catch {
      // Ignored.
    }
  }
  try {
    const remaining = await readdir(base)
    if (remaining.length === 0) await rmdir(base)
  } catch {
    // Ignored.
  }
}
