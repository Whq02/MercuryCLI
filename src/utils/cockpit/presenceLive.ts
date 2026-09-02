import { flagEnv } from '../../substrate/flagRegistry.js'
import { fluxMark } from '../flux/fluxProbe.js'

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs'
import os from 'node:os'
import { basename, join, resolve } from 'path'
import { createHash } from 'crypto'
import { durableTempName } from '../../substrate/durablePublish.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
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
  const rec: PresenceSeat = {
    seat: p.seat,
    verb: p.verb,
    branch: p.branch,
    lastLine: p.lastLine,
    ts: Date.now(),
  }
  const stem = sanitizeSegment(p.seat)
  const finalPath = join(dir, `${stem}.json`)
  const tmpPath = durableTempName(finalPath)
  try {
    writeFileSync(tmpPath, JSON.stringify(rec), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmpPath, finalPath)
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
    for (const f of files) {
      let rec: Partial<PresenceSeat>
      try {
        rec = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Partial<PresenceSeat>
      } catch {
        continue
      }
      if (!rec || typeof rec.seat !== 'string' || typeof rec.ts !== 'number') continue
      if (rec.seat === self) continue
      if (now - rec.ts > STALE_MS) continue
      next.set(rec.seat, {
        seat: rec.seat,
        verb: typeof rec.verb === 'string' ? rec.verb : '',
        branch: typeof rec.branch === 'string' ? rec.branch : '',
        lastLine: typeof rec.lastLine === 'string' ? rec.lastLine : '',
        ts: rec.ts,
      })
    }
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
