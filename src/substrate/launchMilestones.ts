import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getMercuryHome } from '../utils/envUtils.js'
import { flagSpellings } from './flagRegistry.js'

export type LaunchMilestone =
  | 'runtime-entry'
  | 'route-ready'
  | 'first-frame'
  | 'input-live'
  | 'chat-flipped'
  | 'birth-landed'
  | 'birth-refused'

export type LaunchBootKind = 'interactive' | 'headless'

export interface LaunchMilestoneRowV1 {
  schema: 1
  pid: number
  launchId?: string
  milestone: LaunchMilestone
  atMs: number
  boot?: LaunchBootKind
}

interface MilestoneFileV1 {
  version: 1
  rows: LaunchMilestoneRowV1[]
}

const MAX_ROWS = 48

const bootLaunchId: string | undefined = (() => {
  for (const name of flagSpellings('MERCURY_LAUNCH_ID')) {
    const v = process.env[name]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
})()

export function launchMilestonesPath(): string {
  return join(getMercuryHome(), 'launch-milestones.json')
}

function readAll(): LaunchMilestoneRowV1[] {
  try {
    const raw = JSON.parse(readFileSync(launchMilestonesPath(), 'utf8')) as MilestoneFileV1
    if (!raw || raw.version !== 1 || !Array.isArray(raw.rows)) return []
    return raw.rows
  } catch {
    return []
  }
}

const seenThisProcess = new Set<LaunchMilestone>()

const RECORDS_AFTER: Partial<Record<LaunchMilestone, LaunchMilestone>> = { 'input-live': 'first-frame' }
const heldUntil = new Map<LaunchMilestone, Array<{ milestone: LaunchMilestone; opts?: { boot?: LaunchBootKind } }>>()

export function recordLaunchMilestone(milestone: LaunchMilestone, opts?: { boot?: LaunchBootKind }): void {
  if (seenThisProcess.has(milestone)) return
  const after = RECORDS_AFTER[milestone]
  if (after !== undefined && !seenThisProcess.has(after)) {
    const queue = heldUntil.get(after) ?? []
    if (!queue.some(h => h.milestone === milestone)) queue.push({ milestone, opts })
    heldUntil.set(after, queue)
    return
  }
  seenThisProcess.add(milestone)
  try {
    const rows = [
      ...readAll(),
      {
        schema: 1 as const,
        pid: process.pid,
        ...(bootLaunchId !== undefined ? { launchId: bootLaunchId } : {}),
        milestone,
        atMs: Date.now(),
        ...(opts?.boot !== undefined ? { boot: opts.boot } : {}),
      },
    ].slice(-MAX_ROWS)
    writeRows(rows)
  } catch {
  }
  const held = heldUntil.get(milestone)
  if (held !== undefined) {
    heldUntil.delete(milestone)
    for (const h of held) recordLaunchMilestone(h.milestone, h.opts)
  }
}

function writeRows(rows: LaunchMilestoneRowV1[]): void {
  try {
    const path = launchMilestonesPath()
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 10)}`
    writeFileSync(tmp, `${JSON.stringify({ version: 1, rows } satisfies MilestoneFileV1, null, 1)}\n`)
    renameSync(tmp, path)
  } catch {
  }
}

export function readLaunchMilestones(): LaunchMilestoneRowV1[] {
  return readAll()
}

export function lastInteractiveBootSpine(): LaunchMilestoneRowV1[] {
  const rows = readAll()
  const headless = new Set(rows.filter(r => r.boot === 'headless').map(r => r.pid))
  for (let i = rows.length - 1; i >= 0; i--) {
    const pid = rows[i]!.pid
    if (headless.has(pid)) continue
    return rows.filter(r => r.pid === pid)
  }
  return []
}

export function lastBootReachedInputLive(): boolean | null {
  const spine = lastInteractiveBootSpine()
  if (spine.length === 0) return null
  return spine.some(r => r.milestone === 'input-live')
}

export function _resetLaunchMilestonesForTesting(): void {
  seenThisProcess.clear()
}
