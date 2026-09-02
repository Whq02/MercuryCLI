
import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { getMercuryHome } from '../envUtils.js'
import { getSessionAccent } from '../../components/mercury-ui/sessionAccent.js'
import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'

export type CompanionMilestone = 'settle' | 'recovery' | 'firstVerified'

export interface CritterProfile {
  v: 1
  seed: string
  createdAt: number
  milestones: {
    settles: number
    recoveries: number
    firstVerifiedAt?: number
  }
  quiet: boolean
  seenTips: Record<string, number>
  openedSurfaces: string[]
  recoveredAt?: number
}

const SEEN_TIPS_CAP = 200
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

export function seenTipStamps(): Readonly<Record<string, number>> {
  return critterProfile().seenTips
}

export function markTipSeen(id: string, at: number): void {
  const p = critterProfile()
  const entries = Object.entries({ ...p.seenTips, [id]: at }).sort((a, b) => b[1] - a[1]).slice(0, SEEN_TIPS_CAP)
  cached = { ...p, seenTips: Object.fromEntries(entries) }
  writeProfile(cached)
}

export function openedSurfaceSet(): ReadonlySet<string> {
  return new Set(critterProfile().openedSurfaces)
}

export function noteCompanionSurfaceOpened(name: string): void {
  if (!name) return
  const p = critterProfile()
  if (p.openedSurfaces.includes(name)) return
  const openedSurfaces = [...p.openedSurfaces, name].sort().slice(-OPENED_SURFACES_CAP)
  cached = { ...p, openedSurfaces }
  writeProfile(cached)
}

export function resetCritterProfileForTests(): void {
  cached = null
}
