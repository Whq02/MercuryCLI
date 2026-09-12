import { realpathSync, statSync, utimesSync } from 'node:fs'
import * as path from 'node:path'
import { flagEnv } from '../../../substrate/flagRegistry.js'
import { vulcanInstancesUnder, vulcanProcessAlive, type VulcanInstance } from '../instances.js'
import { engineCheckTreeDir, engineChecksDir, engineRunPath, engineRunResultFile, engineTreesDir } from './paths.js'

export const ENGINE_ORPHAN_GRACE_FLAG = 'MERCURY_GODOT_ORPHAN_GRACE_MS'
export const ENGINE_ORPHAN_GRACE_DEFAULT_MS = 30 * 60_000
export const ENGINE_HEARTBEAT_MS = 60_000

export interface EngineEstateEntry {
  kind: 'tree' | 'check'
  id: string
  path: string
}

export type EngineTreeLiveness =
  | { alive: true; why: 'instance'; instance: VulcanInstance }
  | { alive: true; why: 'grace'; ageMs: number }
  | { alive: false; why: 'owner-gone'; instance: VulcanInstance }
  | { alive: false; why: 'grace-over'; ageMs: number }
  | { alive: false; why: 'absent' }

export function engineOrphanGraceMs(): number {
  const raw = flagEnv(ENGINE_ORPHAN_GRACE_FLAG)
  const n = Number(raw)
  return raw !== undefined && raw.trim().length > 0 && Number.isInteger(n) && n >= 0 ? n : ENGINE_ORPHAN_GRACE_DEFAULT_MS
}

function normalized(p: string, platform: NodeJS.Platform): string {
  let s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  if (platform === 'win32') s = s.toLowerCase()
  return s
}

function projectSpellings(projectRoot: string): string[] {
  const out = [projectRoot]
  try {
    const real = realpathSync(projectRoot)
    if (real !== projectRoot) out.push(real)
  } catch {
    return out
  }
  return out
}

export function engineEstateEntry(projectRoot: string, candidate: string, platform: NodeJS.Platform = process.platform): EngineEstateEntry | null {
  for (const root of projectSpellings(projectRoot)) {
    for (const [kind, dir] of [['tree', engineTreesDir(root)], ['check', engineChecksDir(root)]] as const) {
      const prefix = normalized(dir, platform) + '/'
      const rel = normalized(candidate, platform)
      if (!rel.startsWith(prefix)) continue
      const first = rel.slice(prefix.length).split('/')[0] ?? ''
      const id = first.replace(/\.(?:owner\.json|index)$/, '')
      if (id.length === 0) return null
      return { kind, id, path: path.join(dir, id) }
    }
  }
  return null
}

function mtimeOf(file: string): number | null {
  try {
    return statSync(file).mtimeMs
  } catch {
    return null
  }
}

export function engineTreeLiveness(projectRoot: string, candidate: string, now: number = Date.now()): EngineTreeLiveness {
  const entry = engineEstateEntry(projectRoot, candidate)
  if (!entry) return { alive: false, why: 'absent' }
  const roots = entry.kind === 'tree' ? [entry.path] : [engineCheckTreeDir(entry.path)]
  let ownerGone: VulcanInstance | null = null
  for (const root of roots) {
    for (const instance of vulcanInstancesUnder(root)) {
      if (instance.ownerPid === 0 || vulcanProcessAlive(instance.ownerPid)) return { alive: true, why: 'instance', instance }
      ownerGone = instance
    }
  }
  if (ownerGone) return { alive: false, why: 'owner-gone', instance: ownerGone }
  const stamps = [entry.path, `${entry.path}.index`]
  if (entry.kind === 'tree') {
    try {
      const runDir = engineRunPath(projectRoot, entry.id)
      stamps.push(runDir, engineRunResultFile(runDir))
    } catch {
      void 0
    }
  }
  let newest: number | null = null
  for (const stamp of stamps) {
    const at = mtimeOf(stamp)
    if (at !== null && (newest === null || at > newest)) newest = at
  }
  if (newest === null) return { alive: false, why: 'absent' }
  const ageMs = Math.max(0, now - newest)
  return ageMs <= engineOrphanGraceMs() ? { alive: true, why: 'grace', ageMs } : { alive: false, why: 'grace-over', ageMs }
}

export function touchEngineEstate(target: string): void {
  try {
    const now = new Date()
    utimesSync(target, now, now)
  } catch {
    void 0
  }
}

export function startEngineHeartbeat(target: string): () => void {
  touchEngineEstate(target)
  const timer = setInterval(() => touchEngineEstate(target), ENGINE_HEARTBEAT_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
