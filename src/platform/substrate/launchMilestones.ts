import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getMercuryHome } from '../environment/envUtils.js'
import { flagEnv, flagSpellings } from './flagRegistry.js'
import { passedOver } from '../errors/passedOver.js'
import { logForDebugging } from '../logs/debugLog.js'

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
  beforeLaunch?: true
}

interface MilestoneFileV1 {
  version: 1
  rows: LaunchMilestoneRowV1[]
}

const MAX_ROWS = 400

const bootLaunchId: string | undefined = (() => {
  for (const name of flagSpellings('MERCURY_LAUNCH_ID')) {
    const v = flagEnv(name)
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
})()

export function launchMilestonesPath(): string {
  return join(getMercuryHome(), 'launch-milestones.json')
}

function readAll(): LaunchMilestoneRowV1[] {
  let text: string
  try {
    text = readFileSync(launchMilestonesPath(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  try {
    const raw = JSON.parse(text) as MilestoneFileV1
    if (!raw || raw.version !== 1 || !Array.isArray(raw.rows)) {
      logForDebugging(`[launch-milestones] ${launchMilestonesPath()} has unexpected shape; resetting`)
      return []
    }
    return raw.rows
  } catch (error) {
    logForDebugging(`[launch-milestones] ${launchMilestonesPath()} is not valid JSON (${error}); resetting`)
    passedOver(error)
    return []
  }
}

const seenThisProcess = new Set<LaunchMilestone>()
let launchBegun = false

export function markLaunchBegun(): void {
  launchBegun = true
}

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
        ...(milestone === 'first-frame' && !launchBegun ? { beforeLaunch: true as const } : {}),
      },
    ].slice(-MAX_ROWS)
    writeRows(rows)
  } catch (error) {
    passedOver(error)
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
  } catch (error) {
    passedOver(error)
  }
}

function readAllSafe(): LaunchMilestoneRowV1[] {
  try {
    return readAll()
  } catch (error) {
    passedOver(error)
    return []
  }
}

function readAllStrict(): LaunchMilestoneRowV1[] {
  let text: string
  try {
    text = readFileSync(launchMilestonesPath(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const raw = JSON.parse(text) as MilestoneFileV1
  if (!raw || raw.version !== 1 || !Array.isArray(raw.rows)) {
    throw new Error(`${launchMilestonesPath()} has unexpected shape`)
  }
  return raw.rows
}

export function readLaunchMilestones(): LaunchMilestoneRowV1[] {
  return readAllSafe()
}

export function lastInteractiveBootSpine(options?: { strict?: boolean }): LaunchMilestoneRowV1[] {
  const rows = options?.strict ? readAllStrict() : readAllSafe()
  const headless = new Set(rows.filter(r => r.boot === 'headless').map(r => r.pid))
  for (let i = rows.length - 1; i >= 0; i--) {
    const pid = rows[i]!.pid
    if (headless.has(pid)) continue
    return rows.filter(r => r.pid === pid)
  }
  return []
}

export function lastBootReachedInputLive(options?: { strict?: boolean }): boolean | null {
  const spine = lastInteractiveBootSpine(options)
  if (spine.length === 0) return null
  return spine.some(r => r.milestone === 'input-live')
}

export function _resetLaunchMilestonesForTesting(): void {
  seenThisProcess.clear()
  launchBegun = false
}
