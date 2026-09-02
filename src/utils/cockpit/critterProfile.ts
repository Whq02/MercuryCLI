// ============================================================================
//  critterProfile — the persistent LOCAL companion profile ("a selected
//  critter retains one local profile across sessions").
//
//  One tiny JSON per config home (per-operator by construction; no network
//  sync): a stable generated SEED assigned exactly once (the companion's
//  deck seeds from it, so the creature's turn of phrase is its own),
//  discovered milestones (real events the engine records — settles,
//  recoveries, first verified), the quietness preference, the SEEN-TIP
//  memory (a shown tip stays away a while), and the SURFACES the operator
//  has opened (a never-opened surface's tip ranks first). The selected
//  SPECIES stays where it always lived (global config, persistSessionCritter)
//  — one authority.
//
//  A corrupt/missing profile degrades to a fresh seed with an honest
//  `recoveredAt` stamp the dossier can disclose. Fail-soft everywhere; atomic
//  tmp+rename writes.
// ============================================================================

import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { getMercuryHome } from '../envUtils.js'
import { getSessionAccent } from '../../components/mercury-ui/sessionAccent.js'
import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'

export type CompanionMilestone = 'settle' | 'recovery' | 'firstVerified'

export interface CritterProfile {
  v: 1
  /** Assigned once, never rerolled (a corrupt file gets a NEW seed + an
   *  honest recoveredAt stamp — the one legitimate reroll). */
  seed: string
  createdAt: number
  /** Real-event counters (the engine records; animation timing never). */
  milestones: {
    settles: number
    recoveries: number
    firstVerifiedAt?: number
  }
  /** Quiet mode: pose/tone stay expressive, prose is suppressed. */
  quiet: boolean
  /** tip id → epoch ms it was last shown. */
  seenTips: Record<string, number>
  /** Slash commands the operator has opened (sorted, unique). */
  openedSurfaces: string[]
  /** Set when a corrupt profile forced a fresh seed. */
  recoveredAt?: number
}

/** The seen-tip memory keeps at most this many stamps (the oldest fall off). */
const SEEN_TIPS_CAP = 200
/** The opened-surface memory keeps at most this many names. */
const OPENED_SURFACES_CAP = 200

function profilePath(): string {
  return join(getMercuryHome(), 'critter-profile.json')
}

function freshProfile(recovered: boolean): CritterProfile {
  return {
    v: 1,
    seed: randomUUID(),
    createdAt: Date.now(),
    milestones: { settles: 0, recoveries: 0 },
    quiet: false,
    seenTips: {},
    openedSurfaces: [],
    ...(recovered ? { recoveredAt: Date.now() } : {}),
  }
}

let cached: CritterProfile | null = null

function writeProfile(p: CritterProfile): void {
  try {
    durableAtomicPublishSync(profilePath(), JSON.stringify(p, null, 2) + '\n')
  } catch {
    // read-only home: the profile lives for this process only
  }
}

function parseSeenTips(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [id, at] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof at === 'number' && Number.isFinite(at)) out[id] = at
  }
  return out
}

function parseOpenedSurfaces(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return Array.from(new Set(raw.filter((s): s is string => typeof s === 'string' && s.length > 0))).sort()
}

/** The profile, loaded once per process (created/recovered on demand). */
export function critterProfile(): CritterProfile {
  if (cached) return cached
  try {
    const path = profilePath()
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CritterProfile>
      if (parsed && typeof parsed.seed === 'string' && parsed.seed.length > 0) {
        cached = {
          v: 1,
          seed: parsed.seed,
          createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
          milestones: {
            settles: typeof parsed.milestones?.settles === 'number' ? parsed.milestones.settles : 0,
            recoveries: typeof parsed.milestones?.recoveries === 'number' ? parsed.milestones.recoveries : 0,
            ...(typeof parsed.milestones?.firstVerifiedAt === 'number'
              ? { firstVerifiedAt: parsed.milestones.firstVerifiedAt }
              : {}),
          },
          quiet: parsed.quiet === true,
          seenTips: parseSeenTips(parsed.seenTips),
          openedSurfaces: parseOpenedSurfaces(parsed.openedSurfaces),
          ...(typeof parsed.recoveredAt === 'number' ? { recoveredAt: parsed.recoveredAt } : {}),
        }
        return cached
      }
      // Present but unusable → the ONE legitimate reroll, honestly stamped.
      cached = freshProfile(true)
      writeProfile(cached)
      return cached
    }
    cached = freshProfile(false)
    writeProfile(cached)
    return cached
  } catch {
    cached = freshProfile(true)
    writeProfile(cached)
    return cached
  }
}

/** seed:species — the deck seed for the SELECTED companion: the same
 *  creature under the same profile keeps its own turn of phrase. */
export function companionDeckSeed(): string {
  return `${critterProfile().seed}:${getSessionAccent().key}`
}

export function companionQuietPreference(): boolean {
  return critterProfile().quiet
}

export function setCompanionQuiet(quiet: boolean): boolean {
  const p = critterProfile()
  cached = { ...p, quiet }
  writeProfile(cached)
  return quiet
}

/** The engine's milestone recorder — real events only, throttle-free by
 *  nature (settles are seconds apart at minimum). */
export function recordCompanionMilestone(kind: CompanionMilestone): void {
  const p = critterProfile()
  const next: CritterProfile = {
    ...p,
    milestones: {
      ...p.milestones,
      ...(kind === 'settle' ? { settles: p.milestones.settles + 1 } : {}),
      ...(kind === 'recovery'
        ? { recoveries: p.milestones.recoveries + 1, settles: p.milestones.settles + 1 }
        : {}),
      ...(kind === 'firstVerified' && p.milestones.firstVerifiedAt === undefined
        ? { firstVerifiedAt: Date.now() }
        : {}),
    },
  }
  cached = next
  writeProfile(next)
}

/** tip id → epoch ms last shown (the voice's seen filter reads this). */
export function seenTipStamps(): Readonly<Record<string, number>> {
  return critterProfile().seenTips
}

/** Record a shown tip; the memory is capped, oldest stamps falling off. */
export function markTipSeen(id: string, at: number): void {
  const p = critterProfile()
  const entries = Object.entries({ ...p.seenTips, [id]: at }).sort((a, b) => b[1] - a[1]).slice(0, SEEN_TIPS_CAP)
  cached = { ...p, seenTips: Object.fromEntries(entries) }
  writeProfile(cached)
}

/** The surfaces (slash-command names) the operator has opened. */
export function openedSurfaceSet(): ReadonlySet<string> {
  return new Set(critterProfile().openedSurfaces)
}

/** Record an opened surface — written only when it is NEW (a slash command
 *  the operator uses every day never re-writes the profile). */
export function noteCompanionSurfaceOpened(name: string): void {
  if (!name) return
  const p = critterProfile()
  if (p.openedSurfaces.includes(name)) return
  const openedSurfaces = [...p.openedSurfaces, name].sort().slice(-OPENED_SURFACES_CAP)
  cached = { ...p, openedSurfaces }
  writeProfile(cached)
}

/** Proof seam: drop the memo so a proof's on-disk edit is visible. */
export function resetCritterProfileForTests(): void {
  cached = null
}
