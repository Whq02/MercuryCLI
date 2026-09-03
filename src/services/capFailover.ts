import { flagEnv } from '../substrate/flagRegistry.js'

export type CapPosture = 'off' | 'offer' | 'auto'

export type CapQuota = 'allowed' | 'allowed_warning' | 'rejected'

export type CapWindowState = 'allowed' | 'warning' | 'rejected' | 'unknown'

export type CapAction =
  | { kind: 'none' }
  | {
      kind: 'offer'
      trigger: 'warning' | 'rejected' | 'reset'
    }
  | { kind: 'auto-handoff'; trigger: 'rejected' | 'reset' }

export function resolveCapPosture(): CapPosture {
  const raw = flagEnv('MERCURY_CAP_FAILOVER')
  return raw === 'off' || raw === 'auto' ? raw : 'offer'
}

function windowStateOf(state: CapWindowState | CapQuota): CapWindowState {
  return state === 'allowed_warning' ? 'warning' : state
}

export function decideCapAction(posture: CapPosture, state: CapWindowState | CapQuota): CapAction {
  if (posture === 'off') return { kind: 'none' }
  const window = windowStateOf(state)
  if (window === 'allowed' || window === 'unknown') return { kind: 'none' }
  if (window === 'warning') return { kind: 'offer', trigger: 'warning' }
  return posture === 'auto'
    ? { kind: 'auto-handoff', trigger: 'rejected' }
    : { kind: 'offer', trigger: 'rejected' }
}


export interface CapHandoffNote {
  homeModel: string | null
  homeFamily: string
}

let capHandoff: CapHandoffNote | null = null

export function noteCapHandoff(homeModel: string | null, homeFamily: string): void {
  capHandoff = { homeModel, homeFamily }
}

export function noteCapReturn(): void {
  capHandoff = null
}

export function capHandoffState(): CapHandoffNote | null {
  return capHandoff
}

export function clearCapHandoffForFamily(family: string): void {
  if (capHandoff !== null && capHandoff.homeFamily === family) capHandoff = null
}


const offerDismissals = new Set<string>()
const offerAutoActions = new Set<string>()

export function offerDismissed(key: string): boolean {
  return offerDismissals.has(key)
}

export function noteOfferDismissal(key: string): void {
  offerDismissals.add(key)
}

export function offerAutoDone(key: string): boolean {
  return offerAutoActions.has(key)
}

export function noteOfferAutoDone(key: string): void {
  offerAutoActions.add(key)
}

export function _resetOfferMemoriesForTesting(): void {
  offerDismissals.clear()
  offerAutoActions.clear()
  answeredCapOffers.clear()
  capHandoff = null
}


export type CapOfferDirection = 'handoff' | 'return'
const answeredCapOffers = new Set<string>()
const capOfferArmKey = (direction: CapOfferDirection, family: string): string =>
  `${direction}|${family}`

export function capOfferAnswered(direction: CapOfferDirection, family: string): boolean {
  return answeredCapOffers.has(capOfferArmKey(direction, family))
}

export function noteCapOfferAnswered(direction: CapOfferDirection, family: string): void {
  answeredCapOffers.add(capOfferArmKey(direction, family))
}

export function noteCapWindowObserved(family: string, state: CapWindowState): void {
  if (state === 'allowed') {
    answeredCapOffers.delete(capOfferArmKey('handoff', family))
  } else if (state === 'warning' || state === 'rejected') {
    answeredCapOffers.delete(capOfferArmKey('return', family))
  }
}

export interface CapReturnHomeFacts {
  window: CapWindowState | CapQuota
  credentialUsable: boolean
}

export function decideCapReturn(
  posture: CapPosture,
  home: CapReturnHomeFacts,
  onFailoverLane: boolean,
): CapAction {
  if (!onFailoverLane || posture === 'off') return { kind: 'none' }
  if (!home.credentialUsable) return { kind: 'none' }
  if (windowStateOf(home.window) !== 'allowed') return { kind: 'none' }
  return posture === 'auto'
    ? { kind: 'auto-handoff', trigger: 'reset' }
    : { kind: 'offer', trigger: 'reset' }
}


export type SlotWallAction = { kind: 'none' } | { kind: 'offer' } | { kind: 'auto-switch' }

export function decideSlotWallAction(
  posture: CapPosture,
  facts: { activeWalled: boolean; otherSignedIn: boolean; otherWalled: boolean },
): SlotWallAction {
  if (!facts.activeWalled || !facts.otherSignedIn || facts.otherWalled) return { kind: 'none' }
  return posture === 'auto' ? { kind: 'auto-switch' } : { kind: 'offer' }
}


export type CapWindowBasis =
  | 'observed'
  | 'stated-reset-elapsed'
  | 'none'

export interface FamilyWindowFact {
  family: string
  state: CapWindowState
  basis: CapWindowBasis
  resetsAtMs?: number
  windowName?: string
  usedPct?: number
}

export interface FamilyWindowReads {
  now?: () => number
  anthropic?: () => {
    status: CapQuota
    observed: boolean
    resetsAtMs?: number
    windowName?: string
  }
  anthropicWindows?: () => Array<{ key: string; usedPct?: number; resetsAtMs?: number }>
  anthropicPools?: () => Array<{ key: string; label: string; usedPct?: number; resetsAtMs?: number }>
  openaiActiveSource?: () => 'chatgpt-subscription' | 'api-key' | undefined
  openaiWall?: (source: 'chatgpt-subscription' | 'api-key') => { resetsAtMs: number } | null
  openaiBands?: () => Array<{ usedPct: number; resetsAtMs?: number; windowName: string }>
  openrouterWall?: () => { resetsAtMs: number } | null
  geminiWall?: () => { resetsAtMs: number } | null
  huggingfaceWall?: () => { resetsAtMs: number } | null
  laneBilling?: (family: string) => { state: 'credit-exhausted' | 'clear' }
}

export const CAP_APPROACHING_PCT = 70

function liveFamilyWindowReads(): Required<FamilyWindowReads> {
  return {
    now: Date.now,
    anthropicWindows: () => {
      const { anthropicWindowViews } =
        require('./providers/providerUsage.js') as typeof import('./providers/providerUsage.js')
      return anthropicWindowViews()
        .filter(view => view.state === 'live')
        .map(view => ({
          key: view.key,
          ...(view.usedPct !== undefined ? { usedPct: view.usedPct } : {}),
          ...(view.resetsAtMs !== undefined ? { resetsAtMs: view.resetsAtMs } : {}),
        }))
    },
    anthropicPools: () => {
      const { anthropicPoolWindowViews } =
        require('./providers/providerUsage.js') as typeof import('./providers/providerUsage.js')
      return anthropicPoolWindowViews()
        .filter(view => view.state === 'live')
        .map(view => ({
          key: view.key,
          label: view.label,
          ...(view.usedPct !== undefined ? { usedPct: view.usedPct } : {}),
          ...(view.resetsAtMs !== undefined ? { resetsAtMs: view.resetsAtMs } : {}),
        }))
    },
    anthropic: () => {
      const limits = require('./claudeAiLimits.js') as typeof import('./claudeAiLimits.js')
      const current = limits.currentLimits
      return {
        status: current.status,
        observed: limits.claudeWindowObserved(),
        ...(current.resetsAt !== undefined ? { resetsAtMs: current.resetsAt * 1000 } : {}),
        ...(current.rateLimitType !== undefined
          ? { windowName: limits.getRateLimitDisplayName(current.rateLimitType) }
          : {}),
      }
    },
    openaiActiveSource: () => {
      const { resolveOpenaiAccount } =
        require('./providers/openai/openaiAccounts.js') as typeof import('./providers/openai/openaiAccounts.js')
      return resolveOpenaiAccount()?.kind
    },
    openaiWall: source => {
      const { openaiObservedWall } =
        require('./providers/openai/openaiLimitState.js') as typeof import('./providers/openai/openaiLimitState.js')
      return openaiObservedWall(source)
    },
    openaiBands: () => {
      const { openaiObservedUsage } =
        require('./providers/openai/openaiLimitState.js') as typeof import('./providers/openai/openaiLimitState.js')
      const { usageWindowLabel } =
        require('./providers/providerUsage.js') as typeof import('./providers/providerUsage.js')
      const observed = openaiObservedUsage()
      const bands: Array<{ usedPct: number; resetsAtMs?: number; windowName: string }> = []
      for (const band of [observed.primary, observed.secondary]) {
        if (band === undefined || band.usedPct === undefined) continue
        const label = usageWindowLabel(band.windowMinutes)
        bands.push({
          usedPct: band.usedPct,
          ...(band.resetsAtMs !== undefined ? { resetsAtMs: band.resetsAtMs } : {}),
          windowName: label === 'wk' ? 'weekly window' : label === 'win' ? 'usage window' : `${label} window`,
        })
      }
      return bands
    },
    openrouterWall: () => {
      const { openrouterObservedWall } =
        require('./providers/openrouter/openrouterUsageState.js') as typeof import('./providers/openrouter/openrouterUsageState.js')
      return openrouterObservedWall()
    },
    geminiWall: () => {
      const { geminiObservedWall } =
        require('./providers/gemini/geminiUsageState.js') as typeof import('./providers/gemini/geminiUsageState.js')
      return geminiObservedWall()
    },
    huggingfaceWall: () => {
      const { huggingfaceObservedWall } =
        require('./providers/huggingface/huggingfaceUsageState.js') as typeof import('./providers/huggingface/huggingfaceUsageState.js')
      return huggingfaceObservedWall()
    },
    laneBilling: family => {
      if (family === 'huggingface') {
        const { huggingfaceBillingState } =
          require('./providers/huggingface/huggingfaceUsageState.js') as typeof import('./providers/huggingface/huggingfaceUsageState.js')
        if (huggingfaceBillingState().state === 'credit-exhausted') return { state: 'credit-exhausted' }
      }
      const { laneBillingState } =
        require('./providers/laneBillingState.js') as typeof import('./providers/laneBillingState.js')
      return { state: laneBillingState(family as Parameters<typeof laneBillingState>[0]).state }
    },
  }
}

function wallFact(family: string, wall: { resetsAtMs: number }, now: number, windowName: string): FamilyWindowFact {
  return wall.resetsAtMs > now
    ? { family, state: 'rejected', basis: 'observed', resetsAtMs: wall.resetsAtMs, windowName }
    : { family, state: 'allowed', basis: 'stated-reset-elapsed', resetsAtMs: wall.resetsAtMs }
}

export function bindingPoolKeyFor(model: string | null | undefined): string | null {
  if (model === null || model === undefined || model.trim() === '') return null
  let canonical = model
  try {
    const { getCanonicalName } = require('../utils/model/model.js') as typeof import('../utils/model/model.js')
    canonical = getCanonicalName(model)
  } catch {
  }
  const lowered = canonical.toLowerCase()
  if (lowered.includes('fable') || lowered.includes('mythos')) return 'seven_day_fable'
  if (lowered.includes('opus')) return 'seven_day_opus'
  if (lowered.includes('sonnet')) return 'seven_day_sonnet'
  return null
}

const WINDOW_RANK: Record<CapWindowState, number> = { unknown: 0, allowed: 1, warning: 2, rejected: 3 }

export function observedFamilyWindow(
  family: string,
  reads?: FamilyWindowReads,
  opts?: { model?: string | null },
): FamilyWindowFact {
  const r: Required<FamilyWindowReads> = { ...liveFamilyWindowReads(), ...stripUndefined(reads) }
  const unknown: FamilyWindowFact = { family, state: 'unknown', basis: 'none' }
  try {
    const now = r.now()
    if (family === 'anthropic') {
      const a = r.anthropic()
      if (!a.observed) return unknown
      const windowName = a.windowName ?? 'usage window'
      const sharedViews = ((): Array<{ key: string; usedPct?: number; resetsAtMs?: number }> => {
        try {
          return r.anthropicWindows()
        } catch {
          return []
        }
      })()
      const sharedPct = ((): number | undefined => {
        const stated = sharedViews.filter(view => view.usedPct !== undefined)
        if (stated.length === 0) return undefined
        return Math.max(...stated.map(view => view.usedPct as number))
      })()
      const shared: FamilyWindowFact = ((): FamilyWindowFact => {
        if (a.status === 'rejected' || a.status === 'allowed_warning') {
          if (a.resetsAtMs !== undefined && a.resetsAtMs <= now) {
            return { family, state: 'allowed', basis: 'stated-reset-elapsed', resetsAtMs: a.resetsAtMs }
          }
          return {
            family,
            state: a.status === 'rejected' ? 'rejected' : 'warning',
            basis: 'observed',
            ...(a.resetsAtMs !== undefined ? { resetsAtMs: a.resetsAtMs } : {}),
            windowName,
            ...(sharedPct !== undefined ? { usedPct: sharedPct } : {}),
          }
        }
        return { family, state: 'allowed', basis: 'observed', ...(sharedPct !== undefined ? { usedPct: sharedPct } : {}) }
      })()
      const poolKey = bindingPoolKeyFor(opts?.model)
      if (poolKey === null) return shared
      const pool = ((): { key: string; label: string; usedPct?: number; resetsAtMs?: number } | undefined => {
        try {
          return r.anthropicPools().find(view => view.key === poolKey)
        } catch {
          return undefined
        }
      })()
      if (pool === undefined || pool.usedPct === undefined) return shared
      const poolLive = pool.resetsAtMs === undefined || pool.resetsAtMs > now
      if (!poolLive) return shared
      const poolState: CapWindowState =
        pool.usedPct >= 100 ? 'rejected' : pool.usedPct >= CAP_APPROACHING_PCT ? 'warning' : 'allowed'
      const poolFact: FamilyWindowFact = {
        family,
        state: poolState,
        basis: 'observed',
        ...(pool.resetsAtMs !== undefined ? { resetsAtMs: pool.resetsAtMs } : {}),
        windowName: `weekly ${pool.label} limit`,
        usedPct: pool.usedPct,
      }
      const poolRank = WINDOW_RANK[poolFact.state]
      const sharedRank = WINDOW_RANK[shared.state]
      if (poolRank !== sharedRank) return poolRank > sharedRank ? poolFact : shared
      if (shared.usedPct !== undefined && shared.usedPct > pool.usedPct) return shared
      return poolFact
    }
    if (family === 'openai') {
      const source = r.openaiActiveSource()
      if (source === undefined) return unknown
      const wall = r.openaiWall(source)
      if (wall !== null) return wallFact(family, wall, now, 'usage window')
      if (source === 'chatgpt-subscription') {
        const live = r.openaiBands().filter(band => band.resetsAtMs === undefined || band.resetsAtMs > now)
        if (live.length === 0) return billingOrUnknown(family, r, unknown)
        const worst = live.reduce((a, b) => (b.usedPct > a.usedPct ? b : a))
        if (worst.usedPct >= CAP_APPROACHING_PCT) {
          return {
            family,
            state: 'warning',
            basis: 'observed',
            ...(worst.resetsAtMs !== undefined ? { resetsAtMs: worst.resetsAtMs } : {}),
            windowName: worst.windowName,
            usedPct: worst.usedPct,
          }
        }
        return {
          family,
          state: 'allowed',
          basis: 'observed',
          windowName: worst.windowName,
          usedPct: worst.usedPct,
          ...(worst.resetsAtMs !== undefined ? { resetsAtMs: worst.resetsAtMs } : {}),
        }
      }
      return billingOrUnknown(family, r, unknown)
    }
    const laneWall =
      family === 'openrouter'
        ? r.openrouterWall()
        : family === 'gemini'
          ? r.geminiWall()
          : family === 'huggingface'
            ? r.huggingfaceWall()
            : null
    if (laneWall !== null) return wallFact(family, laneWall, now, 'usage window')
    return billingOrUnknown(family, r, unknown)
  } catch {
    return unknown
  }
}

function billingOrUnknown(
  family: string,
  r: Required<FamilyWindowReads>,
  unknown: FamilyWindowFact,
): FamilyWindowFact {
  const billing = r.laneBilling(family)
  return billing.state === 'credit-exhausted'
    ? { family, state: 'rejected', basis: 'observed', windowName: 'credits' }
    : unknown
}

function stripUndefined<T extends object>(reads: T | undefined): Partial<T> {
  const out: Partial<T> = {}
  if (reads === undefined) return out
  for (const [key, value] of Object.entries(reads)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value
  }
  return out
}


export interface CapFailoverCandidate {
  route: string
  model: string
}

export interface CapFailoverExclusion {
  route: string
  why: string
}

export interface CapFailoverListedFamily {
  route: string
  model: string
  window: FamilyWindowFact | null
  atCap: boolean
  usable: boolean
  credential?: 'oauth' | 'api-key' | 'keyless' | 'none'
  blockers: string[]
}

export interface CapFailoverCandidateSet {
  home: string | null
  candidates: CapFailoverCandidate[]
  excluded: CapFailoverExclusion[]
  listed: CapFailoverListedFamily[]
}

export function capUsageWords(window: FamilyWindowFact | null, resetText?: string | null): string {
  if (window === null || window.state === 'unknown') return 'no usage read'
  const name = window.windowName ?? 'usage window'
  if (window.state === 'rejected') {
    return `at its cap — ${name}${resetText ? ` resets ${resetText}` : ''}`
  }
  if (window.usedPct !== undefined) {
    return `${Math.round(window.usedPct)}% of the ${name}`
  }
  return window.state === 'warning' ? `approaching the ${name}` : `${name} clear`
}

export function orderFamiliesBySignIn(
  families: readonly string[],
  signInAt: (family: string) => number | undefined,
): string[] {
  return families
    .map((family, index) => ({ family, index, at: signInAt(family) }))
    .sort((a, b) => {
      if (a.at !== undefined && b.at !== undefined && a.at !== b.at) return b.at - a.at
      if (a.at !== undefined && b.at === undefined) return -1
      if (a.at === undefined && b.at !== undefined) return 1
      return a.index - b.index
    })
    .map(entry => entry.family)
}

export function deriveCapFailoverCandidates(
  home: string | null,
  usability: Record<string, { usable: boolean; blockers: string[]; credential?: 'oauth' | 'api-key' | 'keyless' | 'none' }>,
  targetModelOf: (route: string) => string | undefined,
  signInAt: (family: string) => number | undefined = () => undefined,
  windowOf?: (route: string, model: string) => FamilyWindowFact,
): CapFailoverCandidateSet {
  const candidates: CapFailoverCandidate[] = []
  const excluded: CapFailoverExclusion[] = []
  const listed: CapFailoverListedFamily[] = []
  const capped: CapFailoverListedFamily[] = []
  const families = orderFamiliesBySignIn(
    Object.keys(usability).filter(family => family !== home),
    signInAt,
  )
  for (const route of families) {
    const lane = usability[route]
    if (lane === undefined) {
      excluded.push({ route, why: 'lane not usable' })
      continue
    }
    const model = targetModelOf(route)
    const hasModel = model !== undefined && model.trim() !== ''
    const window = hasModel && windowOf !== undefined ? windowOf(route, model) : null
    const atCap = window !== null && window.state === 'rejected'
    if (atCap && hasModel && lane.credential !== 'none') {
      capped.push({
        route,
        model,
        window,
        atCap: true,
        usable: false,
        ...(lane.credential !== undefined ? { credential: lane.credential } : {}),
        blockers: lane.blockers,
      })
      if (!lane.usable) {
        excluded.push({
          route,
          why: lane.blockers.length > 0 ? lane.blockers.join(' · ') : 'lane at its own usage cap',
        })
      } else {
        excluded.push({ route, why: `the ${route} lane is at its own usage cap` })
      }
      continue
    }
    if (!lane.usable) {
      excluded.push({
        route,
        why: lane.blockers.length > 0 ? lane.blockers.join(' · ') : 'lane not usable',
      })
      continue
    }
    if (!hasModel) {
      excluded.push({ route, why: 'no recorded target model fact — never a guessed id' })
      continue
    }
    candidates.push({ route, model })
    listed.push({
      route,
      model,
      window,
      atCap: false,
      usable: true,
      ...(lane.credential !== undefined ? { credential: lane.credential } : {}),
      blockers: [],
    })
  }
  return { home, candidates, excluded, listed: [...listed, ...capped] }
}

function newestFirstPartyFrontierMember(fallback: string): string {
  try {
    const { CANONICAL_MODEL_IDS } =
      require('../utils/model/configs.js') as typeof import('../utils/model/configs.js')
    const rank = (id: string): number => {
      const m = /^claude-fable-(\d+)(?:-(\d+))?$/.exec(id)
      return m === null ? -1 : Number(m[1]) * 1000 + (m[2] !== undefined ? Number(m[2]) : 0)
    }
    let best: { id: string; rank: number } | undefined
    for (const id of CANONICAL_MODEL_IDS) {
      const r = rank(id)
      if (r >= 0 && (best === undefined || r > best.rank)) best = { id, rank: r }
    }
    return best?.id ?? fallback
  } catch {
    return fallback
  }
}

export function _firstPartyFrontierMemberForTest(fallback: string): string {
  return newestFirstPartyFrontierMember(fallback)
}

export function liveCapFailoverCandidates(home: string | null): CapFailoverCandidateSet {
  const { resolveProviderUsability } =
    require('./providers/providerUsability.js') as typeof import('./providers/providerUsability.js')
  const { getGptSeatAvailability } =
    require('./providers/openai/openaiCatalogue.js') as typeof import('./providers/openai/openaiCatalogue.js')
  const { providerFrontierFact } =
    require('../utils/model/providerFrontier.js') as typeof import('../utils/model/providerFrontier.js')
  const { readSignInLedger } =
    require('../utils/accounts/signInLedger.js') as typeof import('../utils/accounts/signInLedger.js')
  const ledger = ((): Record<string, { at: number }> => {
    try {
      return readSignInLedger()
    } catch {
      return {}
    }
  })()
  const targetOf = (route: string): string | undefined => {
    if (route === 'openai') {
      const seat = getGptSeatAvailability()
      return seat.state === 'ready' ? seat.ids[0] : undefined
    }
    const fact = providerFrontierFact(route as Parameters<typeof providerFrontierFact>[0])?.modelId
    return route === 'anthropic' && fact !== undefined
      ? newestFirstPartyFrontierMember(fact)
      : fact
  }
  return deriveCapFailoverCandidates(
    home,
    resolveProviderUsability(),
    targetOf,
    family => ledger[family]?.at,
    (route, model) => observedFamilyWindow(route, undefined, { model }),
  )
}

export function liveCapFailoverTarget(home: string | null): CapFailoverCandidate | null {
  return liveCapFailoverCandidates(home).candidates[0] ?? null
}


export type LaneSpendKind = 'subscription' | 'metered' | 'local' | 'endpoint' | 'none'

export function laneSpendPosture(
  route: string,
  credential: 'oauth' | 'api-key' | 'keyless' | 'none',
  displayName: string,
): { kind: LaneSpendKind; words: string } {
  if (route === 'local') {
    return { kind: 'local', words: `the ${displayName} lane runs on your own server — no API billing` }
  }
  if (route === 'openai-compat') {
    return { kind: 'endpoint', words: `the ${displayName} lane bills per its endpoint's own terms` }
  }
  if (credential === 'none') {
    return { kind: 'none', words: `the ${displayName} lane has no credential` }
  }
  if (credential === 'oauth' && (route === 'anthropic' || route === 'openai' || route === 'moonshot')) {
    return { kind: 'subscription', words: `the ${displayName} lane runs on your ${displayName} subscription` }
  }
  return {
    kind: 'metered',
    words: `the ${displayName} lane bills per token under your ${displayName} account`,
  }
}
