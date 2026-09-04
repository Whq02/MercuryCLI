import { flagEnv } from '../../substrate/flagRegistry.js'
import { fluxMark } from '../flux/fluxProbe.js'

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'fs'
import os from 'node:os'
import { basename, join, resolve } from 'path'
import { createHash } from 'crypto'
import { durableTempName } from '../../substrate/durablePublish.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { resolveWatchRoot } from '../watchRoot.js'
import { subscribeUiClock } from './uiClock.js'
import { isChannelsEnabled } from '../../services/mcp/channelAllowlist.js'
import { channelsRoot } from '../../services/mcp/channelsRoot.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import { logForDebugging } from '../../utils/debug.js'

export type PresenceSeat = {
  seat: string
  verb: string
  branch: string
  lastLine: string
  ts: number
}

export const STALE_MS = 10_000
export const PRESENCE_TAIL_FLOOR_MS = 10_000

let lastPublished: { path: string; seat: string; verb: string; branch: string; lastLine: string } | null = null
const peerReads = new Map<string, { key: string; rec: Omit<PresenceSeat, 'ts'> | null }>()

let _presence = new Map<string, PresenceSeat>()
let _version = 0
const _subscribers = new Set<() => void>()

export function getOperatorName(): string {
  const env = flagEnv('MERCURY_OPERATOR')?.trim()
  if (env) return env
  try {
    return os.userInfo().username || 'operator'
  } catch {
    return 'operator'
  }
}

function sanitizeSegment(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, '_')
  return /^\.+$/.test(cleaned) ? 'default' : cleaned || 'default'
}

function channelRoom(): string {
  const override = flagEnv('MERCURY_CHANNEL_ROOM')?.trim()
  if (override) return sanitizeSegment(override)
  const cwd = resolve(getOriginalCwd() || process.cwd())
  const base = sanitizeSegment(basename(cwd) || 'default')
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 8)
  return `${base}-${hash}`
}

function presenceActive(): boolean {
  if (flagEnv('MERCURY_CHANNEL_ROOM')?.trim()) return true
  const env = flagEnv('MERCURY_LOCAL_CHANNELS')
  if (isEnvDefinedFalsy(env)) return false
  if (isEnvTruthy(env)) return true
  return isChannelsEnabled()
}

function presenceDirPath(): string {
  return join(channelsRoot(), channelRoom(), 'presence')
}

export function getPresenceDir(): string | null {
  if (!presenceActive()) return null
  try {
    return presenceDirPath()
  } catch {
    return null
  }
}

export function recordSelfPresence(p: Omit<PresenceSeat, 'ts'>): void {
  if (!presenceActive()) return
  let dir: string
  try {
    dir = presenceDirPath()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch (err) {
    logForDebugging(
      `[presence] dir init failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return
  }
  const stem = sanitizeSegment(p.seat)
  const finalPath = join(dir, `${stem}.json`)
  const last = lastPublished
  if (
    last !== null &&
    last.path === finalPath &&
    last.seat === p.seat &&
    last.verb === p.verb &&
    last.branch === p.branch &&
    last.lastLine === p.lastLine
  ) {
    try {
      const now = new Date()
      utimesSync(finalPath, now, now)
      return
    } catch {
    }
  }
  const rec: PresenceSeat = {
    seat: p.seat,
    verb: p.verb,
    branch: p.branch,
    lastLine: p.lastLine,
    ts: Date.now(),
  }
  const tmpPath = durableTempName(finalPath)
  try {
    writeFileSync(tmpPath, JSON.stringify(rec), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmpPath, finalPath)
    lastPublished = { path: finalPath, seat: p.seat, verb: p.verb, branch: p.branch, lastLine: p.lastLine }
  } catch (err) {
    logForDebugging(
      `[presence] write failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    try {
      if (existsSync(tmpPath)) rmSync(tmpPath)
    } catch {
    }
  }
}

export function tailPresence(): void {
  const self = getOperatorName()
  const selfFile = `${sanitizeSegment(self)}.json`
  const now = Date.now()
  const next = new Map<string, PresenceSeat>()
  const dir = getPresenceDir()
  if (dir) {
    let files: string[] = []
    try {
      files = readdirSync(dir).filter(f => f.endsWith('.json'))
    } catch {
      files = []
    }
    const seen = new Set<string>()
    for (const f of files) {
      if (f === selfFile) continue
      const path = join(dir, f)
      let st: { mtimeMs: number; size: number; ino: number }
      try {
        st = statSync(path)
      } catch {
        continue
      }
      if (now - st.mtimeMs > STALE_MS) continue
      seen.add(path)
      const key = `${st.size}:${st.ino}`
      let cached = peerReads.get(path)
      if (cached === undefined || cached.key !== key) {
        let rec: Partial<PresenceSeat> | null = null
        try {
          rec = JSON.parse(readFileSync(path, 'utf8')) as Partial<PresenceSeat>
        } catch {
          continue
        }
        cached = {
          key,
          rec:
            rec !== null && typeof rec.seat === 'string'
              ? {
                  seat: rec.seat,
                  verb: typeof rec.verb === 'string' ? rec.verb : '',
                  branch: typeof rec.branch === 'string' ? rec.branch : '',
                  lastLine: typeof rec.lastLine === 'string' ? rec.lastLine : '',
                }
              : null,
        }
        peerReads.set(path, cached)
      }
      if (cached.rec === null || cached.rec.seat === self) continue
      next.set(cached.rec.seat, { ...cached.rec, ts: Math.round(st.mtimeMs) })
    }
    for (const path of [...peerReads.keys()]) if (!seen.has(path)) peerReads.delete(path)
  }
  const changed =
    next.size !== _presence.size ||
    [...next].some(([seat, v]) => {
      const prev = _presence.get(seat)
      return (
        !prev ||
        prev.verb !== v.verb ||
        prev.branch !== v.branch ||
        prev.lastLine !== v.lastLine ||
        prev.ts !== v.ts
      )
    })
  if (!changed) return
  _presence = next
  _version++
  fluxMark('presence:publish')
  for (const cb of [..._subscribers]) {
    try {
      cb()
    } catch {
    }
  }
}

export function startPresenceTail(): () => void {
  let watcher: FSWatcher | null = null
  const arm = (): void => {
    if (watcher !== null) return
    const dir = getPresenceDir()
    if (dir === null || !existsSync(dir)) return
    try {
      const w = watch(resolveWatchRoot(dir), () => tailPresence())
      w.on('error', () => {
        try {
          w.close()
        } catch {
        }
        if (watcher === w) watcher = null
      })
      watcher = w
    } catch {
    }
  }
  arm()
  tailPresence()
  const stopFloor = subscribeUiClock(PRESENCE_TAIL_FLOOR_MS, () => {
    arm()
    tailPresence()
  })
  return () => {
    stopFloor()
    try {
      watcher?.close()
    } catch {
    }
    watcher = null
  }
}

export function getLivePresence(): PresenceSeat[] {
  return [..._presence.values()].sort((a, b) => a.seat.localeCompare(b.seat))
}

export function subscribePresence(cb: () => void): () => void {
  _subscribers.add(cb)
  return () => {
    _subscribers.delete(cb)
  }
}

export function getPresenceVersion(): number {
  return _version
}
