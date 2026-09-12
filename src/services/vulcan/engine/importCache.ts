import { createHash } from 'node:crypto'
import { constants, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { engineCacheDir } from './paths.js'

export const ENGINE_CACHE_KEEP = 3
export const CLASS_CACHE_FILE = 'global_script_class_cache.cfg'

export interface EngineCacheSeed {
  hit: boolean
  seededFrom: string | null
}

export function engineCacheEntryDir(projectRoot: string, key: string): string {
  return path.join(engineCacheDir(projectRoot), key, 'godot')
}

export function engineCacheHas(projectRoot: string, key: string): boolean {
  return existsSync(path.join(engineCacheEntryDir(projectRoot, key), CLASS_CACHE_FILE))
}

export function engineCacheEntries(projectRoot: string): Array<{ key: string; dir: string; mtimeMs: number }> {
  const root = engineCacheDir(projectRoot)
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  const out: Array<{ key: string; dir: string; mtimeMs: number }> = []
  for (const key of names) {
    if (key.startsWith('.') || key.includes('.tmp-')) continue
    const dir = path.join(root, key, 'godot')
    try {
      const st = statSync(dir)
      if (st.isDirectory()) out.push({ key, dir, mtimeMs: st.mtimeMs })
    } catch {
      continue
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

function cloneDir(src: string, dest: string): void {
  cpSync(src, dest, { recursive: true, force: true, mode: constants.COPYFILE_FICLONE })
}

export function seedEngineTree(projectRoot: string, treeRoot: string, key: string): EngineCacheSeed {
  const target = path.join(treeRoot, '.godot')
  rmSync(target, { recursive: true, force: true })
  const exact = engineCacheEntryDir(projectRoot, key)
  if (engineCacheHas(projectRoot, key)) {
    cloneDir(exact, target)
    return { hit: true, seededFrom: exact }
  }
  const newest = engineCacheEntries(projectRoot)[0]
  if (newest) {
    cloneDir(newest.dir, target)
    return { hit: false, seededFrom: newest.dir }
  }
  return { hit: false, seededFrom: null }
}

export function storeEngineCache(projectRoot: string, treeRoot: string, key: string): { stored: boolean; dir: string; reason: string | null } {
  const source = path.join(treeRoot, '.godot')
  const dir = engineCacheEntryDir(projectRoot, key)
  if (!existsSync(path.join(source, CLASS_CACHE_FILE))) return { stored: false, dir, reason: `${source} carries no ${CLASS_CACHE_FILE}` }
  const entry = path.dirname(dir)
  const tmp = `${entry}.tmp-${process.pid}-${Date.now()}`
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  cloneDir(source, path.join(tmp, 'godot'))
  rmSync(entry, { recursive: true, force: true })
  mkdirSync(path.dirname(entry), { recursive: true })
  renameSync(tmp, entry)
  pruneEngineCache(projectRoot)
  return { stored: true, dir, reason: null }
}

export function pruneEngineCache(projectRoot: string, keep: number = ENGINE_CACHE_KEEP): string[] {
  const removed: string[] = []
  for (const entry of engineCacheEntries(projectRoot).slice(keep)) {
    rmSync(path.dirname(entry.dir), { recursive: true, force: true })
    removed.push(entry.key)
  }
  return removed
}

export function classCacheDigest(treeRoot: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path.join(treeRoot, '.godot', CLASS_CACHE_FILE))).digest('hex')
  } catch {
    return null
  }
}
