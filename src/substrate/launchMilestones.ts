import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getMercuryHome } from '../utils/envUtils.js'
import { flagSpellings } from './flagRegistry.js'

export type LaunchMilestone =
  | 'runtime-entry'
  | 'route-ready'
  | 'first-frame'
  | 'input-live'

export interface LaunchMilestoneRowV1 {
  schema: 1
  pid: number
  launchId?: string
  milestone: LaunchMilestone
  atMs: number
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

export function recordLaunchMilestone(milestone: LaunchMilestone): void {
  if (seenThisProcess.has(milestone)) return
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
      },
    ].slice(-MAX_ROWS)
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

export function lastBootReachedInputLive(): boolean | null {
  const rows = readAll()
  if (rows.length === 0) return null
  const lastPid = rows[rows.length - 1]!.pid
  const spine = rows.filter(r => r.pid === lastPid)
  return spine.some(r => r.milestone === 'input-live')
}

export function _resetLaunchMilestonesForTesting(): void {
  seenThisProcess.clear()
}
