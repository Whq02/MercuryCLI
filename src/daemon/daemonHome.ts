import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { publishAtomicSync } from '../substrate/fileStore.js'

type DaemonHomeWatch = { dir: string; onGone: (where: string) => void; gone: boolean }

let watch: DaemonHomeWatch | null = null

export function armDaemonHomeWatch(dir: string, onGone: (where: string) => void): void {
  watch = { dir, onGone, gone: false }
}

function watchOver(dir: string | undefined): DaemonHomeWatch | null {
  if (watch === null) return null
  if (dir !== undefined && dir !== watch.dir) return null
  return watch
}

function tripHomeGone(w: DaemonHomeWatch, where: string): void {
  if (w.gone) return
  w.gone = true
  w.onGone(where)
}

export function daemonHomeStands(where: string, dir?: string): boolean {
  const w = watchOver(dir)
  if (w === null) return true
  if (w.gone) return false
  if (existsSync(w.dir)) return true
  tripHomeGone(w, where)
  return false
}

export function publishInDaemonHome(
  where: string,
  path: string,
  contents: string | Uint8Array,
  opts?: { dir?: string; mode?: number },
): 'published' | 'home-gone' {
  const w = watchOver(opts?.dir)
  if (w === null) {
    publishAtomicSync(path, contents, { mode: opts?.mode })
    return 'published'
  }
  if (w.gone) return 'home-gone'
  try {
    publishAtomicSync(path, contents, { mode: opts?.mode, parent: 'must-stand' })
    return 'published'
  } catch (e) {
    if ((e as { fsCode?: unknown } | null)?.fsCode !== 'ENOENT') throw e
    tripHomeGone(w, where)
    return 'home-gone'
  }
}

export function ensureDirInDaemonHome(where: string, path: string, dir?: string): boolean {
  const w = watchOver(dir)
  if (w === null) {
    mkdirSync(path, { recursive: true })
    return true
  }
  if (w.gone) return false
  if (resolve(path) === resolve(w.dir)) {
    tripHomeGone(w, where)
    return false
  }
  try {
    mkdirSync(path)
    return true
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return true
    if (code !== 'ENOENT') throw e
    tripHomeGone(w, where)
    return false
  }
}
