
import { getSessionId, onSessionSwitch } from '../../bootstrap/state.js'
import { displayWidth } from '../../components/mercury-ui/glyphs.js'
import { BUDDY_FRESH_MS, buddyStateFor, type BuddyState } from './buddyState.js'
import { companionTurnSignals, resetCompanionSignals, subscribeCompanionSignals } from './companionSignals.js'
import {
  chooseLine,
  createDeck,
  freshVoiceState,
  HOLDING_AFTER_MS,
  LONG_WORK_MS,
  maySpeak,
  mayTip,
  noteSettle,
  noteSpoken,
  noteTip,
  pickTip,
  RETURN_AFTER_MS,
  TIP_BOOT_QUIET_MS,
  type Deck,
  type Moment,
  type VoiceState,
} from './companionVoice.js'
import { MOMENT_LINES, TIP_BANK } from './companionWords.js'
import { getLiveContextUsage } from './contextUsageLive.js'
import {
  companionDeckSeed,
  companionQuietPreference,
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
let clockCadence: number | null = null
let lastTypingAt = 0
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
  const now = clock()
  lastTypingAt = now
  if (per.lastActivityAt > 0 && now - per.lastActivityAt >= RETURN_AFTER_MS) per.returnPending = true
  per.lastActivityAt = now
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

function desiredCadence(mood: BuddyState, failurePending: boolean): number {
  if (per.quip || failurePending) return 1_000
  if ((mood === 'blocked' && !per.holdingSpoken) || !per.bootTipDone || per.returnPending) return 5_000
  return 30_000
}

function armClock(mood: BuddyState, failurePending = false): void {
  const want = desiredCadence(mood, failurePending)
  if (clockCadence === want) return
  unsubClock?.()
  clockCadence = want
  unsubClock = subscribeUiClock(want, () => recompute())
}

function emit(): void {
  for (const cb of listeners) {
    try {
      cb()
    } catch {
    }
  }
}

function show(text: string, kind: SpeechKind, now: number): void {
  per.quip = { text, at: now, kind, ttl: kind === 'tip' ? TIP_MS : QUIP_MS }
}

function speak(moment: Moment, now: number, typing: boolean): boolean {
  if (companionQuietPreference()) return false
  if (typing && moment !== 'holding') return false
  if (!maySpeak(per.voice, moment, now)) return false
  const pool = MOMENT_LINES[moment].filter(l => fitsCompanionBudget(l))
  if (pool.length === 0) return false
  const line = chooseLine(deck(), per.voice, moment, pool)
  if (line === null) return false
  show(line, 'moment', now)
  noteSpoken(per.voice, moment, line, now)
  return true
}

function fittingTips(): typeof TIP_BANK {
  return TIP_BANK.filter(t => fitsCompanionBudget(t.text))
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

function tryTip(now: number, typing: boolean): boolean {
  if (companionQuietPreference() || typing) return false
  if (!mayTip(per.voice, now, per.bootedAt)) return false
  const tip = pickTip(deck(), per.voice, fittingTips(), seenTipStamps(), tipSignals(), now)
  if (tip === null) return false
  show(tip.text, 'tip', now)
  noteTip(per.voice, tip.text, now)
  markTipSeen(tip.id, now)
  return true
}

function recompute(): void {
  ensureSessionKey()
  const now = clock()
  const sig = companionTurnSignals()
  const typing = now - lastTypingAt < TYPING_QUIET_MS

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

  let returned = false
  if (sig.turnStartTs !== null && sig.turnStartTs !== per.lastTurnStartSeen) {
    per.lastTurnStartSeen = sig.turnStartTs
    if (per.returnPending || (per.lastActivityAt > 0 && now - per.lastActivityAt >= RETURN_AFTER_MS)) returned = true
    per.returnPending = false
    per.lastActivityAt = now
  } else if (per.returnPending && !typing) {
    returned = true
    per.returnPending = false
  }

  if (failFresh) per.sawFailThisTurn = true
  const prev = per.prevMood
  per.prevMood = mood
  const settled = prev !== null && prev !== 'done' && mood === 'done'
  if (settled) {
    recordCompanionMilestone(per.sawFailThisTurn ? 'recovery' : 'settle')
    per.sawFailThisTurn = false
  }

  if (returned) {
    if (!speak('silence', now, typing)) tryTip(now, typing)
  }
  if (settled) {
    const long = (sig.lastTurnDurationMs ?? 0) >= LONG_WORK_MS
    const spoke = long ? speak('settled-long', now, typing) : false
    noteSettle(per.voice, spoke)
    if (long && !spoke) tryTip(now, typing)
  }
  if (mood === 'blocked') {
    if (per.blockedSince === null) {
      per.blockedSince = now
      per.holdingSpoken = false
    }
    if (!per.holdingSpoken && now - per.blockedSince >= HOLDING_AFTER_MS) {
      per.holdingSpoken = true
      speak('holding', now, typing)
    }
  } else {
    per.blockedSince = null
  }
  const failurePending = mood === 'sad' && sig.lastTurnErrorTs !== null && per.failureSpokenAt !== sig.lastTurnErrorTs
  if (failurePending && speak('failure', now, typing)) per.failureSpokenAt = sig.lastTurnErrorTs
  if (!per.bootTipDone && now - per.bootedAt >= TIP_BOOT_QUIET_MS && !sig.turnLive && !typing) {
    per.bootTipDone = true
    if (per.quip === null) tryTip(now, typing)
  }

  if (per.quip && now - per.quip.at > per.quip.ttl) per.quip = null

  const pose = toCritterState(mood)
  const changed =
    snapshot.mood !== mood ||
    snapshot.pose !== pose ||
    (snapshot.quip?.text ?? null) !== (per.quip?.text ?? null) ||
    (snapshot.quip?.at ?? 0) !== (per.quip?.at ?? 0)
  if (changed) {
    snapshot = {
      mood,
      pose,
      quip: per.quip ? { ...per.quip } : null,
      version: snapshot.version + 1,
    }
    emit()
  }
  if (listeners.size > 0) armClock(mood, failurePending)
}

export function requestCompanionTip(): string | null {
  ensureSessionKey()
  const now = clock()
  const tip = pickTip(deck(), per.voice, fittingTips(), seenTipStamps(), tipSignals(), now, true)
  if (tip === null) return null
  show(tip.text, 'tip', now)
  noteTip(per.voice, tip.text, now)
  markTipSeen(tip.id, now)
  recompute()
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
    armClock(snapshot.mood)
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
      clockCadence = null
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
  lastTypingAt = 0
  budgets.clear()
  snapshot = { mood: 'idle', pose: toCritterState('idle'), quip: null, version: snapshot.version + 1 }
  emit()
}
