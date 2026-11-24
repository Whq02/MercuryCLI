import { appendFileSync, chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { passedOver } from '../../platform/errors/passedOver.js'
import { posixFileModesApply } from '../../platform/host-os/files.js'
import { publishAtomicSync, renameWithWin32RetrySync } from '../../platform/substrate/fileStore.js'

const DAEMON_DIR_MODE = 0o700
const DAEMON_FILE_MODE = 0o600

export function ensureDaemonHomeDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DAEMON_DIR_MODE })
  if (!posixFileModesApply()) return
  try {
    chmodSync(dir, DAEMON_DIR_MODE)
  } catch (error) {
    passedOver(error)
  }
}

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
  const mode = opts?.mode ?? DAEMON_FILE_MODE
  const w = watchOver(opts?.dir)
  if (w === null) {
    mkdirSync(dirname(path), { recursive: true, mode: DAEMON_DIR_MODE })
    publishAtomicSync(path, contents, { mode })
    return 'published'
  }
  if (w.gone) return 'home-gone'
  try {
    publishAtomicSync(path, contents, { mode, parent: 'must-stand' })
    return 'published'
  } catch (e) {
    if ((e as { fsCode?: unknown } | null)?.fsCode !== 'ENOENT') throw e
    tripHomeGone(w, where)
    return 'home-gone'
  }
}

export function appendInDaemonHome(
  where: string,
  path: string,
  line: string,
  opts?: { dir?: string; parent?: 'create' | 'must-stand' },
): 'appended' | 'home-gone' {
  const w = watchOver(opts?.dir)
  if (w === null) {
    if (opts?.parent !== 'must-stand') mkdirSync(dirname(path), { recursive: true, mode: DAEMON_DIR_MODE })
    appendFileSync(path, line, { mode: DAEMON_FILE_MODE })
    return 'appended'
  }
  if (w.gone) return 'home-gone'
  try {
    appendFileSync(path, line, { mode: DAEMON_FILE_MODE })
    return 'appended'
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    tripHomeGone(w, where)
    return 'home-gone'
  }
}

export function publishTransientInDaemonHome(where: string, path: string, contents: string, dir?: string): 'published' | 'home-gone' {
  const w = watchOver(dir)
  if (w !== null && w.gone) return 'home-gone'
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, contents, { mode: DAEMON_FILE_MODE })
    renameWithWin32RetrySync(tmp, path)
    return 'published'
  } catch (e) {
    if (w === null || (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    tripHomeGone(w, where)
    return 'home-gone'
  }
}

export function ensureDirInDaemonHome(where: string, path: string, dir?: string): boolean {
  const w = watchOver(dir)
  if (w === null) {
    mkdirSync(path, { recursive: true, mode: DAEMON_DIR_MODE })
    return true
  }
  if (w.gone) return false
  if (resolve(path) === resolve(w.dir)) {
    tripHomeGone(w, where)
    return false
  }
  try {
    mkdirSync(path, { mode: DAEMON_DIR_MODE })
    return true
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return true
    if (code !== 'ENOENT') throw e
    tripHomeGone(w, where)
    return false
  }
}
