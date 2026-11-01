import { randomUUID } from 'node:crypto'
import { lstat, mkdir, opendir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { compileCacheDirUsable } from './compileCachePath.js'

export const COMPILE_CACHE_MAX_BYTES = 512 * 1024 * 1024
export const COMPILE_CACHE_MAX_FILES = 8192
export const COMPILE_CACHE_PRUNE_INTERVAL_MS = 60 * 60 * 1000
const BUCKET = /^v\d+\.\d+\.\d+-[A-Za-z0-9_]+-[0-9a-f]{8}(?:-\d+)?$/
const RETIRED = /^\.prune-(v\d+\.\d+\.\d+-[A-Za-z0-9_]+-[0-9a-f]{8}(?:-\d+)?)-[0-9a-f-]{36}$/

type PruneResult = { state: 'skipped' | 'fresh' | 'busy' | 'complete' | 'failed'; removed: string[] }

export async function pruneCompileCache(home: string, env: NodeJS.ProcessEnv = process.env): Promise<PruneResult> {
  const root = join(home, 'compile-cache')
  const samePath = (a: string, b: string): boolean => process.platform === 'win32'
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)
  if (env.NODE_DISABLE_COMPILE_CACHE !== undefined || (env.NODE_COMPILE_CACHE && !samePath(env.NODE_COMPILE_CACHE, root)) || !compileCacheDirUsable(root)) return { state: 'skipped', removed: [] }
  const rootStat = await lstat(root).catch(() => null)
  if (!rootStat?.isDirectory()) return { state: 'skipped', removed: [] }
  const stamp = join(root, '.last-prune')
  const fresh = async (): Promise<boolean> => {
    const info = await lstat(stamp).catch(() => null)
    const age = info ? Date.now() - info.mtimeMs : Infinity
    return info?.isFile() === true && age >= 0 && age < COMPILE_CACHE_PRUNE_INTERVAL_MS
  }
  if (await fresh()) return { state: 'fresh', removed: [] }
  const { acquirePidLock, releasePidLock } = await import('../../substrate/pidLock.js')
  const lock = join(root, '.prune.lock')
  const owner = randomUUID()
  if (!(await acquirePidLock(lock, owner, { liveness: 'assume-alive' })).held) return { state: 'busy', removed: [] }
  const removed: string[] = []
  try {
    if (await fresh()) return { state: 'fresh', removed }
    const entries = await readdir(root, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && RETIRED.test(entry.name)) await rm(join(root, entry.name), { recursive: true, force: true })
    }
    const retire = async (name: string): Promise<void> => {
      const path = join(root, name)
      const retired = join(root, `.prune-${name}-${randomUUID()}`)
      await rename(path, retired)
      await mkdir(path, { recursive: true })
      await rm(retired, { recursive: true, force: true })
      removed.push(name)
    }
    const buckets: Array<{ name: string; bytes: number; files: number; mtime: number }> = []
    let bytes = 0
    let files = 0
    for (const entry of entries) {
      if (!entry.isDirectory() || !BUCKET.test(entry.name)) continue
      const path = join(root, entry.name)
      if (!(await lstat(path)).isDirectory()) continue
      const bucket = { name: entry.name, bytes: 0, files: 0, mtime: 0 }
      for await (const file of await opendir(path)) {
        if (!file.isFile()) continue
        const info = await lstat(join(path, file.name)).catch(() => null)
        if (!info?.isFile()) continue
        bucket.bytes += info.size
        bucket.files++
        bucket.mtime = Math.max(bucket.mtime, info.mtimeMs)
        if (bucket.bytes > COMPILE_CACHE_MAX_BYTES || bucket.files > COMPILE_CACHE_MAX_FILES) break
      }
      if (bucket.bytes > COMPILE_CACHE_MAX_BYTES || bucket.files > COMPILE_CACHE_MAX_FILES) {
        await retire(entry.name)
      } else {
        buckets.push(bucket)
        bytes += bucket.bytes
        files += bucket.files
      }
    }
    for (const bucket of buckets.sort((a, b) => a.mtime - b.mtime)) {
      if (bytes <= COMPILE_CACHE_MAX_BYTES && files <= COMPILE_CACHE_MAX_FILES) break
      await retire(bucket.name)
      bytes -= bucket.bytes
      files -= bucket.files
    }
    await writeFile(stamp, new Date().toISOString(), { mode: 0o600 })
    return { state: 'complete', removed }
  } catch {
    return { state: 'failed', removed }
  } finally {
    await releasePidLock(lock, owner)
  }
}
