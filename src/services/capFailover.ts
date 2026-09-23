import { flagEnv } from '../substrate/flagRegistry.js'
import { stringWidth } from '../ink/stringWidth.js'
import type { UsageWindowView } from './providers/providerUsage.js'
import { FIRST_WARNING_PCT, usageWarningTier, usageWindowState, type UsageWarningTier } from './providers/limitWarning.js'

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
  if (window === 'warning') return { kind: 'none' }
  return posture === 'auto'
    ? { kind: 'auto-handoff', trigger: 'rejected' }
    : { kind: 'offer', trigger: 'rejected' }
}


export interface CapHandoffNote {
  homeModel: string | null
  homeFamily: string
}

let capHandoff: CapHandoffNote | null = null
let capHandoffVersion = 0
const capHandoffListeners = new Set<() => void>()

function capHandoffChanged(): void {
  capHandoffVersion += 1
  for (const listener of capHandoffListeners) listener()
}

export function noteCapHandoff(homeModel: string | null, homeFamily: string): void {
  capHandoff = { homeModel, homeFamily }
  capHandoffChanged()
}

export function noteCapReturn(): void {
  if (capHandoff === null) return
  capHandoff = null
  capHandoffChanged()
}

export function capHandoffState(): CapHandoffNote | null {
  return capHandoff
}

export function clearCapHandoffForFamily(family: string): void {
  if (capHandoff !== null && capHandoff.homeFamily === family) {
    capHandoff = null
    capHandoffChanged()
  }
}

export function subscribeCapHandoff(listener: () => void): () => void {
  capHandoffListeners.add(listener)
  return () => {
    capHandoffListeners.delete(listener)
  }
}

export function getCapHandoffVersion(): number {
  return capHandoffVersion
}

export function capFailoverLaneOf(liveRoute: string | null): string | null {
  return capHandoff !== null && liveRoute !== null && liveRoute !== capHandoff.homeFamily ? liveRoute : null
}

export const FAILOVER_LINE_DEFAULT_MS = 120_000
const FAILOVER_LINE_FLOOR_MS = 1000

export function failoverLineMs(): number {
  const raw = flagEnv('MERCURY_FAILOVER_LINE_MS')
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return FAILOVER_LINE_DEFAULT_MS
  const parsed = Number(raw.trim())
  return parsed >= FAILOVER_LINE_FLOOR_MS ? parsed : FAILOVER_LINE_DEFAULT_MS
}

export interface CapLaneLineFacts {
  lane: string
  modelName: string
  homeName: string
  homeWindow: FamilyWindowFact | null
  resetText: string | undefined
}

export const CAP_LANE_LINE_TAIL = ' · /model to return'

export function capLaneLineBody(facts: CapLaneLineFacts): string {
  const reset =
    facts.homeWindow !== null && (facts.homeWindow.state === 'rejected' || facts.homeWindow.state === 'warning') && facts.resetText !== undefined
      ? ` · ${facts.homeName} window resets ${facts.resetText}`
      : ''
  return `on the ${facts.lane} failover lane · ${facts.modelName}${reset}`
}

export function capLaneLineWords(facts: CapLaneLineFacts): string {
  return `${capLaneLineBody(facts)}${CAP_LANE_LINE_TAIL}`
}

export type CapLaneLineCutV1 = { body: string; bodyColumns: number; tail: string }

export function capLaneLineCut(words: string, columns: number): CapLaneLineCutV1 | null {
  if (!words.endsWith(CAP_LANE_LINE_TAIL) || stringWidth(words) <= columns) return null
  return { body: words.slice(0, words.length - CAP_LANE_LINE_TAIL.length), bodyColumns: Math.max(1, columns - stringWidth(CAP_LANE_LINE_TAIL)), tail: CAP_LANE_LINE_TAIL }
}

export function capLaneLineKey(facts: CapLaneLineFacts): string {
  return `${capLaneLineWords(facts)}|${facts.homeWindow?.state ?? 'unknown'}`
}

let laneLine: { key: string; armedAtMs: number } | null = null

export function capLaneLineUntil(key: string | null, nowMs: number): number | null {
  if (key === null) {
    laneLine = null
    return null
  }
  if (laneLine === null || laneLine.key !== key) laneLine = { key, armedAtMs: nowMs }
  return laneLine.armedAtMs + failoverLineMs()
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

export function slotWallKey(family: string, active: string): string {
  return `slot|${family}|${active}`
}

export function noteSlotWallObserved(family: string, active: string, walled: boolean): void {
  if (walled) return
  const key = slotWallKey(family, active)
  offerDismissals.delete(key)
  offerAutoActions.delete(key)
}

export function _resetOfferMemoriesForTesting(): void {
  offerDismissals.clear()
  offerAutoActions.clear()
  answeredCapOffers.clear()
  capHandoff = null
  laneLine = null
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
  warningTier?: UsageWarningTier
  staleWords?: string
}

export interface FamilyWindowReads {
  now?: () => number
  anthropic?: () => {
    status: CapQuota
    observed: boolean
    resetsAtMs?: number
    windowName?: string
    usedPct?: number
  }
  anthropicWindows?: () => UsageWindowView[]
  anthropicPools?: () => UsageWindowView[]
  openaiActiveSource?: () => 'chatgpt-subscription' | 'api-key' | undefined
  openaiWall?: (source: 'chatgpt-subscription' | 'api-key') => { resetsAtMs: number } | null
  openaiBands?: () => Array<{
    usedPct: number
    resetsAtMs?: number
    windowName: string
    state?: UsageWindowView['state']
    observedAtMs?: number
    source?: UsageWindowView['source']
    freshForMs?: number
  }>
  percentageWindows?: (family: 'moonshot' | 'openrouter') => UsageWindowView[]
  openrouterWall?: () => { resetsAtMs: number } | null
  geminiWall?: () => { resetsAtMs: number } | null
  huggingfaceWall?: () => { resetsAtMs: number } | null
  laneBilling?: (family: string) => { state: 'credit-exhausted' | 'clear' }
}

export const CAP_APPROACHING_PCT = FIRST_WARNING_PCT

function liveFamilyWindowReads(): Required<FamilyWindowReads> {
  return {
    now: Date.now,
    anthropicWindows: () => {
      const { anthropicWindowViews } =
        require('./providers/providerUsage.js') as typeof import('./providers/providerUsage.js')
      return anthropicWindowViews().filter(view => view.state === 'live')
    },
    anthropicPools: () => {
      const { anthropicPoolWindowViews } =
        require('./providers/providerUsage.js') as typeof import('./providers/providerUsage.js')
      return anthropicPoolWindowViews().filter(view => view.state === 'live')
    },
    anthropic: () => {
      const limits = require('./claudeAiLimits.js') as typeof import('./claudeAiLimits.js')
      const current = limits.currentLimits
      return {
        status: current.status,
        observed: limits.claudeWindowObserved(),
        ...(current.rateLimitType !== 'overage' && current.utilization !== undefined ? { usedPct: current.utilization * 100 } : {}),
        ...(current.resetsAt !== undefined ? { resetsAtMs: current.resetsAt * 1000 } : {}),
        ...(current.rateLimitType !== undefined
          ? { windowName: limits.getRateLimitDisplayName(current.rateLimitType) }
          : {}),
      }
    },
    openaiActiveSource: () => {
      const { activeWalletEntry } = require('./wallet/wallet.js') as typeof import('./wallet/wallet.js')
      const entry = activeWalletEntry('openai')
      return entry === undefined ? undefined : entry.kind === 'api-key' ? 'api-key' : 'chatgpt-subscription'
    },
    openaiWall: source => {
      const { openaiObservedWall } =
        require('./providers/openai/openaiLimitState.js') as typeof import('./providers/openai/openaiLimitState.js')
      return openaiObservedWall(source)
    },
    openaiBands: () => {
      const { openaiObservedWindowViews, usageWindowWord } = require('./providers/providerUsage.js') as typeof import('./providers/providerUsage.js')
      return openaiObservedWindowViews().filter(view => view.usedPct !== undefined).map(view => ({
        ...view,
        usedPct: view.usedPct!,
        windowName: usageWindowWord(view),
      }))
    },
    percentageWindows: family => {
      const { usageForProvider } = require('./providers/providerUsage.js') as typeof import('./providers/providerUsage.js')
      return usageForProvider(family).windows
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


function bindingWindowOfSeat(
  model: string | null | undefined,
  windows: () => UsageWindowView[],
  pools: () => UsageWindowView[],
  now: number,
): { window: UsageWindowView; windowName: string } | undefined {
  if (model === null || model === undefined || model.trim() === '') return undefined
  try {
    const { bindingWindowOf } =
      require('./providers/providerUsage.js') as typeof import('./providers/providerUsage.js')
    return bindingWindowOf(
      { provider: 'anthropic', shape: 'subscription-windows', windows: windows().filter(w => w.resetsAtMs === undefined || w.resetsAtMs > now), pools: pools().filter(w => w.resetsAtMs === undefined || w.resetsAtMs > now) },
      model,
    )
  } catch {
    return undefined
  }
}

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
      const binding = bindingWindowOfSeat(opts?.model, r.anthropicWindows, r.anthropicPools, now)
      const bindingLive = binding !== undefined && binding.window.usedPct !== undefined &&
        Number.isFinite(binding.window.usedPct) &&
        (binding.window.resetsAtMs === undefined || binding.window.resetsAtMs > now)
      if (!a.observed && !bindingLive) return unknown
      const elapsed = a.resetsAtMs !== undefined && a.resetsAtMs <= now
      if (a.observed && a.status === 'rejected' && !elapsed) {
        return { family, state: 'rejected', basis: 'observed', windowName: a.windowName ?? 'usage window', ...(a.resetsAtMs !== undefined ? { resetsAtMs: a.resetsAtMs } : {}) }
      }
      const headerPct = a.observed && !elapsed ? a.usedPct : undefined
      const useBinding = bindingLive && binding !== undefined &&
        (headerPct === undefined || binding.window.usedPct! >= headerPct)
      const pct = useBinding ? binding!.window.usedPct : headerPct
      const resetsAtMs = useBinding ? binding!.window.resetsAtMs : a.resetsAtMs
      const windowName = useBinding ? binding!.windowName : a.windowName
      const tier = usageWarningTier(pct)
      return {
        family,
        state: usageWindowState(pct),
        basis: elapsed && pct === undefined ? 'stated-reset-elapsed' : 'observed',
        ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
        ...(windowName !== undefined ? { windowName } : {}),
        ...(pct !== undefined ? { usedPct: pct } : {}),
        ...(tier !== null ? { warningTier: tier } : {}),
      }
    }
    if (family === 'openai') {
      const source = r.openaiActiveSource()
      if (source === undefined) return unknown
      const wall = r.openaiWall(source)
      const bands = (() => {
        try { return source === 'chatgpt-subscription' ? r.openaiBands().filter(b => Number.isFinite(b.usedPct)) : [] }
        catch { return [] }
      })()
      if (wall !== null) {
        const matches = bands.filter(b => b.resetsAtMs === wall.resetsAtMs)
        const matching = matches.length === 1 ? matches[0] : undefined
        const reached = bands.filter(b => b.usedPct >= 100 && (b.resetsAtMs === undefined || b.resetsAtMs > now))
        const named = matching ?? (reached.length === 1 ? reached[0] : undefined)
        return wallFact(family, wall, now, named?.windowName ?? 'usage window')
      }
      const billing = billingOrUnknown(family, r, unknown)
      if (billing.state === 'rejected' || source !== 'chatgpt-subscription') return billing
      const { usageFreshness, usageSourceWords } = require('./providers/usageFreshness.js') as typeof import('./providers/usageFreshness.js')
      const live = bands.filter(b => b.state !== 'unavailable' && (b.resetsAtMs === undefined || b.resetsAtMs > now) && usageFreshness(b, now).state !== 'stale')
      if (live.length === 0) {
        if (bands.length === 0) return billing
        const latest = bands.reduce((a, b) => (b.observedAtMs ?? 0) > (a.observedAtMs ?? 0) ? b : a)
        return { ...unknown, staleWords: usageSourceWords(latest, now) ?? 'stale usage read' }
      }
      const worst = live.reduce((a, b) => (b.usedPct > a.usedPct ? b : a))
      const tier = usageWarningTier(worst.usedPct)
      return {
        family,
        state: usageWindowState(worst.usedPct),
        basis: 'observed',
        ...(worst.resetsAtMs !== undefined ? { resetsAtMs: worst.resetsAtMs } : {}),
        windowName: worst.windowName,
        usedPct: worst.usedPct,
        ...(tier !== null ? { warningTier: tier } : {}),
      }
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
    const billing = billingOrUnknown(family, r, unknown)
    if (billing.state === 'rejected') return billing
    if (family === 'moonshot' || family === 'openrouter') {
      const { worstLiveWindow, usageWindowWord } = require('./providers/providerUsage.js') as typeof import('./providers/providerUsage.js')
      const worst = worstLiveWindow(r.percentageWindows(family).filter(w => w.resetsAtMs === undefined || w.resetsAtMs > now))
      if (worst !== null) {
        const tier = usageWarningTier(worst.usedPct)
        return {
          family,
          state: usageWindowState(worst.usedPct),
          basis: 'observed',
          usedPct: worst.usedPct,
          windowName: usageWindowWord(worst),
          ...(worst.resetsAtMs !== undefined ? { resetsAtMs: worst.resetsAtMs } : {}),
          ...(tier !== null ? { warningTier: tier } : {}),
        }
      }
    }
    return billing
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
  if (window?.staleWords !== undefined) return window.staleWords
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
