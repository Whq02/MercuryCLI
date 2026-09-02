// ============================================================================
//  routerOutcomeStore — the small, local, inspectable route-outcome memory
//  (adaptive route calibration — NOT a hidden optimiser).
//
//  One bounded ring of settled-route observations keyed by a COARSE task
//  signature (mode : taskShape : ambiguity-band : coupling-band). Contents are
//  bands + booleans + timestamps — never prompts, never model prose, never
//  source. Policy consumption is bounded at the compiler (OUTCOME_MIN_SAMPLES
//  gate + OUTCOME_MAX_WEIGHT cap + this module's exponential decay), so
//  semantic intent stays primary; `/router reset-history` empties it.
// ============================================================================
import { join } from 'node:path'
import type { RouteProfile, RouteTaskShape } from '../utils/router/contracts.js'
import { defineStore } from './fileStore.js'
import { routerStateDir } from './routerPaths.js'

const OUTCOME_RING_CAP = 300
/** Exponential decay half-life for history weight (ms) — ~2 weeks. */
export const OUTCOME_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000

export interface RouteOutcomeRow {
  ts: number
  /** 'mission' rows are the policy layer's observations (H3) — same
   *  ring, same decay, filtered out of the scribe/party priors by mode. */
  mode: 'scribe' | 'party' | 'mission'
  taskShape: RouteTaskShape
  ambiguity: number
  coupling: number
  /** RouteProfile for router rows; a mission profile id for mission rows
   *  (each writer owns its closed vocabulary). */
  profile: RouteProfile | (string & {})
  modelClass: string
  /** Accepted on attempt 1 (true) vs revised/failed first (false). */
  firstPass: boolean
  /** Policy-history epoch (mission rows only) — wrong-epoch rows are
   *  mechanically ignored by the mission reader. */
  epoch?: string
}

export interface RouterOutcomeState {
  rows: RouteOutcomeRow[]
  updatedAt: number
}

function decodeRow(raw: unknown): RouteOutcomeRow | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.ts !== 'number' || typeof r.firstPass !== 'boolean') return null
  if (r.mode !== 'scribe' && r.mode !== 'party' && r.mode !== 'mission') return null
  if (typeof r.taskShape !== 'string' || typeof r.profile !== 'string') return null
  if (typeof r.ambiguity !== 'number' || typeof r.coupling !== 'number') return null
  if (typeof r.modelClass !== 'string') return null
  return {
    ts: r.ts,
    mode: r.mode,
    taskShape: r.taskShape as RouteTaskShape,
    ambiguity: r.ambiguity,
    coupling: r.coupling,
    profile: r.profile as RouteProfile,
    modelClass: r.modelClass,
    firstPass: r.firstPass,
    ...(typeof r.epoch === 'string' ? { epoch: r.epoch } : {}),
  }
}

export const routerOutcomeStore = defineStore<RouterOutcomeState, []>({
  name: 'routerOutcomes',
  schemaVersion: 1,
  path: () => join(routerStateDir(), 'outcomes.json'),
  onReadFailure: 'empty',
  empty: () => ({ rows: [], updatedAt: 0 }),
  decode: raw => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const r = raw as Record<string, unknown>
    return {
      rows: Array.isArray(r.rows)
        ? r.rows.map(decodeRow).filter((x): x is RouteOutcomeRow => x !== null).slice(-OUTCOME_RING_CAP)
        : [],
      updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
    }
  },
})

/** Append one settled observation (fire-and-forget; never throws). */
export async function recordRouteOutcome(row: RouteOutcomeRow): Promise<void> {
  try {
    await routerOutcomeStore().mutate(s => ({
      rows: [...s.rows, row].slice(-OUTCOME_RING_CAP),
      updatedAt: row.ts,
    }))
  } catch {
    // calibration only — never disturbs the settle path
  }
}

/** Decayed signature stats for the compiler's bounded prior. */
export async function readOutcomeSnapshot(sig: {
  mode: 'scribe' | 'party'
  taskShape: RouteTaskShape
  ambiguity: number
  coupling: number
  now: number
}): Promise<{ sampleCount: number; acceptedFirstPassRate: number } | undefined> {
  try {
    const state = await routerOutcomeStore().read()
    const rows = state.rows.filter(
      r =>
        r.mode === sig.mode &&
        r.taskShape === sig.taskShape &&
        r.ambiguity === sig.ambiguity &&
        r.coupling === sig.coupling,
    )
    if (rows.length === 0) return undefined
    let weight = 0
    let firstPass = 0
    for (const r of rows) {
      const w = Math.pow(0.5, Math.max(0, sig.now - r.ts) / OUTCOME_HALF_LIFE_MS)
      weight += w
      if (r.firstPass) firstPass += w
    }
    if (weight <= 0) return undefined
    return { sampleCount: rows.length, acceptedFirstPassRate: firstPass / weight }
  } catch {
    return undefined
  }
}

/** Decayed per-profile stats for the mission policy layer (H3).
 *  Mission rows only, CURRENT epoch only — wrong-epoch history is invisible
 *  here by construction (stale outcomes cannot govern a changed catalogue).
 *  The out-of-epoch presence flag lets the selector NAME the exclusion. */
export async function readMissionOutcomeStats(sig: {
  taskShape: RouteTaskShape
  epoch: string
  now: number
}): Promise<{
  perProfile: { profile: string; sampleCount: number; acceptedRate: number }[]
  outOfEpochRows: number
}> {
  try {
    const state = await routerOutcomeStore().read()
    const missionRows = state.rows.filter(r => r.mode === 'mission' && r.taskShape === sig.taskShape)
    const inEpoch = missionRows.filter(r => r.epoch === sig.epoch)
    const byProfile = new Map<string, { weight: number; firstPass: number; count: number }>()
    for (const row of inEpoch) {
      const w = Math.pow(0.5, Math.max(0, sig.now - row.ts) / OUTCOME_HALF_LIFE_MS)
      const agg = byProfile.get(row.profile) ?? { weight: 0, firstPass: 0, count: 0 }
      agg.weight += w
      agg.count += 1
      if (row.firstPass) agg.firstPass += w
      byProfile.set(row.profile, agg)
    }
    return {
      perProfile: [...byProfile.entries()]
        .filter(([, agg]) => agg.weight > 0)
        .map(([profile, agg]) => ({
          profile,
          sampleCount: agg.count,
          acceptedRate: agg.firstPass / agg.weight,
        }))
        .sort((a, b) => (a.profile < b.profile ? -1 : 1)),
      outOfEpochRows: missionRows.length - inEpoch.length,
    }
  } catch {
    return { perProfile: [], outOfEpochRows: 0 }
  }
}

/** Append one VERIFIED mission-policy observation (grader/evidence-backed
 *  settlements only — unverified turns never mint history). */
export async function recordMissionOutcome(input: {
  profileId: string
  taskShape: RouteTaskShape
  ambiguity: number
  coupling: number
  accepted: boolean
  epoch: string
  modelClass: string
  now?: number
}): Promise<void> {
  await recordRouteOutcome({
    ts: input.now ?? Date.now(),
    mode: 'mission',
    taskShape: input.taskShape,
    ambiguity: input.ambiguity,
    coupling: input.coupling,
    profile: input.profileId,
    modelClass: input.modelClass,
    firstPass: input.accepted,
    epoch: input.epoch,
  })
}

/** `/router reset-history` — empty the ring (the operator's forget switch). */
export async function resetOutcomeHistory(now = Date.now()): Promise<void> {
  try {
    await routerOutcomeStore().mutate(() => ({ rows: [], updatedAt: now }))
  } catch {
    // best-effort
  }
}
