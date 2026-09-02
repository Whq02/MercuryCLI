// ============================================================================
//  substrate/launchMilestones — the milestone
//  instrumentation: launch-ID-keyed typed milestones BESIDE the existing
//  beacon estate (bootBeacon stays the attempt/clear pair; the splash
//  receipt stays file — this store records the RUNTIME-side spine
//  so a boot's outcome is distinguishable after the fact: runtime entry →
//  route-ready → first coherent frame → input-live).
//
//  · One bounded JSON (FIFO ~48 rows ≈ 8 boots), fail-soft everywhere —
//    milestones are telemetry, never a boot dependency.
//  · launchId: the launch id captured at module load (the alt-hold
//    consumes the env one-shot later; a pre-splash/non-splash boot simply
//    has none — rows still key by pid+bootAtMs).
//  · FALSE EXIT 0 cannot read as success: a boot that died pre-input-live
//    leaves its spine truncated (entry without input-live) — exactly what
//    the beacon warn floor + doctor read.
// ============================================================================
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getMercuryHome } from '../utils/envUtils.js'
import { flagSpellings } from './flagRegistry.js'

export type LaunchMilestone =
  | 'runtime-entry'
  | 'route-ready'
  | 'first-frame'
  | 'input-live'
  /** The boot face's New Session: the chat route flipped (the cockpit
   *  paints held) BEFORE the birth answered — then the birth landed, or
   *  was refused (the face takes the frame back with the reason). The
   *  order of these rows is the flip-first law's own record. */
  | 'chat-flipped'
  | 'birth-landed'
  | 'birth-refused'

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

// Captured at load: the launcher alt-hold consumes MERCURY_LAUNCH_ID
// one-shot — read both spellings before that happens.
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

/** Record one milestone (exactly once per process per kind; fail-soft). */
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
    /* telemetry only — never a boot dependency */
  }
}

/** The bounded read (doctor + provers). */
export function readLaunchMilestones(): LaunchMilestoneRowV1[] {
  return readAll()
}

/** The doctor's spine question: did the LAST boot (by pid grouping) reach
 *  input-live? A truncated spine is the false-success signal the beacon
 *  warn floor complements. */
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
