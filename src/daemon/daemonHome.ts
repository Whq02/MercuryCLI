import { existsSync } from 'node:fs'

type DaemonHomeWatch = { dir: string; onGone: (where: string) => void; gone: boolean }

let watch: DaemonHomeWatch | null = null

export function armDaemonHomeWatch(dir: string, onGone: (where: string) => void): void {
  watch = { dir, onGone, gone: false }
}

export function daemonHomeStands(where: string, dir?: string): boolean {
  if (watch === null) return true
  if (dir !== undefined && dir !== watch.dir) return true
  if (watch.gone) return false
  if (existsSync(watch.dir)) return true
  watch.gone = true
  watch.onGone(where)
  return false
}
