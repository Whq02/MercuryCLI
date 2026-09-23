
import { getSessionId, onSessionSwitch } from '../../bootstrap/state.js'
import { displayWidth } from '../../components/mercury-ui/glyphs.js'
import { BUDDY_FRESH_MS, buddyStateFor, type BuddyState } from './buddyState.js'
import { companionTurnSignals, resetCompanionSignals, subscribeCompanionSignals } from './companionSignals.js'
import {
  createDeck,
  freshVoiceState,
  noteTip,
  pickTip,
  type Deck,
  type VoiceState,
} from './companionVoice.js'
import { tipBank } from './companionWords.js'
import { getLiveContextUsage } from './contextUsageLive.js'
import {
  companionDeckSeed,
  markTipSeen,
  openedSurfaceSet,
  recordCompanionMilestone,
  seenTipStamps,
} from './critterProfile.js'
import { isCritterAsleep, subscribeCritterSleep } from './critterSleep.js'
import { toCritterState } from './critterVariant.js'
import type { CritterState } from './critterData.js'
import { subscribeUiClock } from './uiClock.js'

export const SETTLE_MS = 8_000
export const QUIP_MS = 12_000
export const TIP_MS = 20_000
export const QUIP_FADE_MS = 8_000
export const TYPING_QUIET_MS = 2_000

export type SpeechKind = 'moment' | 'tip'

export interface CompanionEngineSnapshot {
  mood: BuddyState
  pose: CritterState
  quip: { text: string; at: number; kind: SpeechKind; ttl: number } | null
  version: number
}

type PerSessionState = {
  prevMood: BuddyState | null
  quip: { text: string; at: number; kind: SpeechKind; ttl: number } | null
  voice: VoiceState
  deck: Deck | null
  sawFailThisTurn: boolean
  blockedSince: number | null
  holdingSpoken: boolean
  failureSpokenAt: number | null
  lastTurnStartSeen: number | null
  lastActivityAt: number
  returnPending: boolean
  bootedAt: number
  bootTipDone: boolean
}

const freshSessionState = (now: number): PerSessionState => ({
  prevMood: null,
  quip: null,
  voice: freshVoiceState(),
  deck: null,
  sawFailThisTurn: false,
  blockedSince: null,
  holdingSpoken: false,
  failureSpokenAt: null,
  lastTurnStartSeen: null,
  lastActivityAt: now,
  returnPending: false,
  bootedAt: now,
  bootTipDone: false,
})

let sessionKey = ''
let per = freshSessionState(Date.now())
const parked = new Map<string, PerSessionState>()

let snapshot: CompanionEngineSnapshot = {
  mood: 'idle',
  pose: toCritterState('idle'),
  quip: null,
  version: 0,
}

const listeners = new Set<() => void>()
let unsubSignals: (() => void) | null = null
let unsubSleep: (() => void) | null = null
let unsubClock: (() => void) | null = null
let unsubSwitch: (() => void) | null = null
let clock: () => number = () => Date.now()

const budgets = new Map<string, number>()

function speechBudget(): number {
  let min = Number.POSITIVE_INFINITY
  for (const cells of budgets.values()) if (cells < min) min = cells
  return min
}

export function fitsCompanionBudget(line: string, cells: number = speechBudget()): boolean {
  return displayWidth(line) <= cells
}

export function setCompanionSpeechBudget(surface: string, cells: number | null): void {
  if (cells === null) budgets.delete(surface)
  else budgets.set(surface, Math.max(0, Math.floor(cells)))
  if (per.quip && !fitsCompanionBudget(per.quip.text)) {
    per.quip = null
    if (listeners.size > 0) recompute()
  }
}

export function noteCompanionTyping(): void {
  per.lastActivityAt = clock()
}

function ensureSessionKey(): void {
  const sid = getSessionId() || 'boot'
  if (sid === sessionKey) return
  if (sessionKey) parked.set(sessionKey, per)
  sessionKey = sid
  per = parked.get(sid) ?? freshSessionState(clock())
  resetCompanionSignals()
}

function deck(): Deck {
  if (!per.deck) per.deck = createDeck(`${companionDeckSeed()}:${sessionKey}`)
  return per.deck
}

const CLOCK_CADENCE_MS = 30_000

function armClock(): void {
  if (unsubClock !== null) return
  unsubClock = subscribeUiClock(CLOCK_CADENCE_MS, () => recompute())
}

function emit(): void {
  for (const cb of listeners) {
    try {
      cb()
    } catch {
    }
  }
}

function fittingTips(): ReturnType<typeof tipBank> {
  return tipBank().filter(t => fitsCompanionBudget(t.text))
}

function tipSignals(): { contextPct: number | null; openedSurfaces: ReadonlySet<string> } {
  let contextPct: number | null = null
  try {
    contextPct = getLiveContextUsage()?.usedPct ?? null
  } catch {
    contextPct = null
  }
  return { contextPct, openedSurfaces: openedSurfaceSet() }
}

function recompute(): void {
  ensureSessionKey()
  const now = clock()
  const sig = companionTurnSignals()

  const failFresh =
    sig.lastTurnEndedInError &&
    sig.lastTurnErrorTs !== null &&
    now - sig.lastTurnErrorTs < BUDDY_FRESH_MS

  const mood = buddyStateFor(
    { isMain: true, status: 'running' },
    {
      activeStatus: sig.turnLive
        ? { live: true, turnStartTs: sig.turnStartTs ? new Date(sig.turnStartTs).toISOString() : null }
        : null,
      activeStreaming: sig.streaming ? { text: 't' } : null,
      perm: sig.awaitingPermission ? {} : null,
      justSettled: !sig.turnLive && sig.lastTurnEndTs != null && now - sig.lastTurnEndTs < SETTLE_MS,
      recentFail: failFresh,
      asleep: isCritterAsleep(),
    },
    now,
  )

  if (failFresh) per.sawFailThisTurn = true
  const prev = per.prevMood
  per.prevMood = mood
  const settled = prev !== null && prev !== 'done' && mood === 'done'
  if (settled) {
    recordCompanionMilestone(per.sawFailThisTurn ? 'recovery' : 'settle')
    per.sawFailThisTurn = false
  }

  const pose = toCritterState(mood)
  const changed = snapshot.mood !== mood || snapshot.pose !== pose
  if (changed) {
    snapshot = { mood, pose, quip: null, version: snapshot.version + 1 }
    emit()
  }
  if (listeners.size > 0) armClock()
}

export function requestCompanionTip(): string | null {
  ensureSessionKey()
  const now = clock()
  const tip = pickTip(deck(), per.voice, fittingTips(), seenTipStamps(), tipSignals(), now, true)
  if (tip === null) return null
  noteTip(per.voice, tip.text, now)
  markTipSeen(tip.id, now)
  return tip.text
}

export function companionEngineSnapshot(): CompanionEngineSnapshot {
  return snapshot
}

export function companionEngineVersion(): number {
  return snapshot.version
}

export function subscribeCompanionEngine(cb: () => void): () => void {
  listeners.add(cb)
  if (listeners.size === 1) {
    unsubSignals = subscribeCompanionSignals(() => recompute())
    unsubSleep = subscribeCritterSleep(() => recompute())
    unsubSwitch = onSessionSwitch(() => recompute())
    recompute()
    armClock()
  }
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0) {
      unsubSignals?.()
      unsubSignals = null
      unsubSleep?.()
      unsubSleep = null
      unsubSwitch?.()
      unsubSwitch = null
      unsubClock?.()
      unsubClock = null
    }
  }
}

export function companionEngineStatsForProofs(): {
  listeners: number
  clockArmed: boolean
  signalsArmed: boolean
  sessionKey: string
  parkedSessions: number
  voice: VoiceState
  speechBudget: number
} {
  return {
    listeners: listeners.size,
    clockArmed: unsubClock !== null,
    signalsArmed: unsubSignals !== null,
    sessionKey,
    parkedSessions: parked.size,
    voice: per.voice,
    speechBudget: speechBudget(),
  }
}

export function recomputeCompanionForProofs(): void {
  recompute()
}

export function setCompanionClockForProofs(next: (() => number) | null): void {
  clock = next ?? (() => Date.now())
}

export function resetCompanionEngineForTests(): void {
  per = freshSessionState(clock())
  parked.clear()
  sessionKey = ''
  budgets.clear()
  snapshot = { mood: 'idle', pose: toCritterState('idle'), quip: null, version: snapshot.version + 1 }
  emit()
}
