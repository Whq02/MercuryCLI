// ============================================================================
//  companionEngine — the ONE companion state machine.
//
//  Every companion surface (the deck row, the hero bubble, the mini critter,
//  the /critter dossier) selects from THIS engine:
//
//    · ONE snapshot (mood · pose · speech · version) observed by all mounts;
//    · moods derive from the HONEST seams — companionSignals (the REPL's
//      published turn facts), agentStateSnapshot's content-derived verdict,
//      the ONE critterSleep verdict for the 'sleeping' word, the typing ping
//      from the prompt — nothing here invents state;
//    · SPEECH is the voice law (companionVoice) over the approved words
//      (companionWords): four moments — a long run settled, a permission
//      held on the operator, a failure, a return after a long silence — plus
//      a TIP on quiet moments (session start, a return, a long run that
//      settled without a moment line). A seeded no-repeat deck per session,
//      a global cooldown, consecutive settles never both speak, no tip while
//      typing, at most one tip per ten minutes, a seen-tip memory in the
//      profile, quiet mode silences every line;
//    · timers ride the shared uiClock (1s only while a line is live, 5s while
//      a hold or the boot tip is pending, 30s otherwise) and exist ONLY while
//      a surface subscribes — a session with no companion surface mounted
//      runs none of this;
//    · SESSION-SCOPED: a switch parks the outgoing session's edges and
//      restores (or freshly starts) the incoming one's — edges, the voice
//      state and the deck never leak across sessions;
//    · milestones (settles, recoveries, first verified) fold into the
//      persistent critter profile — real events only, never animation timing.
// ============================================================================

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
import { agentStateSnapshot } from './index.js'
import { subscribeUiClock } from './uiClock.js'

/** A settled turn reads `done` for this long before decaying to idle. */
export const SETTLE_MS = 8_000
/** A moment line lives this long… */
export const QUIP_MS = 12_000
/** …a tip a little longer (it is meant to be read), … */
export const TIP_MS = 20_000
/** …and either dims for its final stretch past this age (the fade idiom). */
export const QUIP_FADE_MS = 8_000
/** Keystrokes quieter than this ago suppress non-holding speech. */
export const TYPING_QUIET_MS = 2_000

export type SpeechKind = 'moment' | 'tip'

export interface CompanionEngineSnapshot {
  mood: BuddyState
  pose: CritterState
  /** Live speech (null when silent / quiet mode). */
  quip: { text: string; at: number; kind: SpeechKind; ttl: number } | null
  /** Bumps only on a REAL change — useSyncExternalStore's comparator. */
  version: number
}

type PerSessionState = {
  prevMood: BuddyState | null
  quip: { text: string; at: number; kind: SpeechKind; ttl: number } | null
  voice: VoiceState
  deck: Deck | null
  /** Milestone edge memory (per session — profile keeps the durable copy). */
  sawFailThisTurn: boolean
  /** The current hold's start, null while not blocked. */
  blockedSince: number | null
  holdingSpoken: boolean
  failureSpoken: boolean
  /** The last turn start the engine has seen (the start edge). */
  lastTurnStartSeen: number | null
  /** The operator's last activity (boot · a turn start · a keystroke). */
  lastActivityAt: number
  /** A return after RETURN_AFTER_MS was detected on a keystroke; it speaks
   *  at the next quiet check. */
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
  failureSpoken: false,
  lastTurnStartSeen: null,
  lastActivityAt: now,
  returnPending: false,
  bootedAt: now,
  bootTipDone: false,
})

// ── module state ─────────────────────────────────────────────────────────────
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
/** The engine's clock — Date.now() in the product; a prover pins it. */
let clock: () => number = () => Date.now()

// ── the speech budget: no line may ever overflow its row ─────────────────────
// Every mounted surface reports how many cells it can give a line at the live
// terminal size (companionBudget); the engine speaks only lines that fit the
// NARROWEST mounted surface — a line that does not fit is not chosen, and a
// live line that stops fitting (a resize) leaves the screen. Never truncated,
// never wrapped, never spilled. With no surface mounted nothing paints, so
// every line "fits".
const budgets = new Map<string, number>()

function speechBudget(): number {
  let min = Number.POSITIVE_INFINITY
  for (const cells of budgets.values()) if (cells < min) min = cells
  return min
}

/** Does `line` fit the narrowest mounted surface (or `cells`, when given)? */
export function fitsCompanionBudget(line: string, cells: number = speechBudget()): boolean {
  return displayWidth(line) <= cells
}

/** A surface's budget for a line, in cells; `null` withdraws it (unmount). */
export function setCompanionSpeechBudget(surface: string, cells: number | null): void {
  if (cells === null) budgets.delete(surface)
  else budgets.set(surface, Math.max(0, Math.floor(cells)))
  if (per.quip && !fitsCompanionBudget(per.quip.text)) {
    per.quip = null
    if (listeners.size > 0) recompute()
  }
}

/** The prompt's keystroke ping: no tip and no settle line mid-typing, and
 *  the first keystroke after a long quiet marks the operator's return. */
export function noteCompanionTyping(): void {
  const now = clock()
  lastTypingAt = now
  if (per.lastActivityAt > 0 && now - per.lastActivityAt >= RETURN_AFTER_MS) per.returnPending = true
  per.lastActivityAt = now
}

function ensureSessionKey(): void {
  const sid = getSessionId() || 'boot'
  if (sid === sessionKey) return
  // Park the outgoing session's edges; restore or freshly start the new one.
  if (sessionKey) parked.set(sessionKey, per)
  sessionKey = sid
  per = parked.get(sid) ?? freshSessionState(clock())
  // The signal store is REPL-published per active session — reset its edge
  // stamps so the incoming session derives from its own facts, not the
  // outgoing session's lastTurnEndTs (the cross-session leak this engine
  // exists to close). The REPL republishes current facts on its next effect.
  resetCompanionSignals()
}

function deck(): Deck {
  if (!per.deck) per.deck = createDeck(`${companionDeckSeed()}:${sessionKey}`)
  return per.deck
}

function desiredCadence(mood: BuddyState): number {
  if (per.quip) return 1_000
  if ((mood === 'blocked' && !per.holdingSpoken) || !per.bootTipDone || per.returnPending) return 5_000
  return 30_000
}

function armClock(mood: BuddyState): void {
  const want = desiredCadence(mood)
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
      /* one throwing subscriber never blocks the rest */
    }
  }
}

function show(text: string, kind: SpeechKind, now: number): void {
  per.quip = { text, at: now, kind, ttl: kind === 'tip' ? TIP_MS : QUIP_MS }
}

/** Speak a moment line if the voice law allows it. Returns true when spoken. */
function speak(moment: Moment, now: number, typing: boolean): boolean {
  if (companionQuietPreference()) return false
  // holding is about the operator's attention — it may interrupt typing.
  if (typing && moment !== 'holding') return false
  if (!maySpeak(per.voice, moment, now)) return false
  // Only lines that fit the narrowest mounted surface are in the pool; an
  // empty pool is honest silence.
  const pool = MOMENT_LINES[moment].filter(l => fitsCompanionBudget(l))
  if (pool.length === 0) return false
  const line = chooseLine(deck(), per.voice, moment, pool)
  if (line === null) return false
  show(line, 'moment', now)
  noteSpoken(per.voice, moment, line, now)
  return true
}

/** The bank, less every tip that would overflow the narrowest mounted surface. */
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

/** Show a tip on a quiet moment if the tip law allows it. */
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

  // The stumble beat: the content-derived per-turn verdict says the last
  // turn FAILED, and that turn ended within the freshness window.
  const agent = agentStateSnapshot()
  const failFresh =
    agent.state === 'live' &&
    agent.data.verdict?.state === 'failed' &&
    sig.lastTurnEndTs != null &&
    now - sig.lastTurnEndTs < BUDDY_FRESH_MS

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
      // THE one sleep truth: the 'sleeping' word rides the critterSleep
      // agent-activity verdict — the same derivation the art animates from —
      // never a private idle timer.
      asleep: isCritterAsleep(),
    },
    now,
  )

  // ── the turn-start edge: activity, and the return after a long quiet ──────
  let returned = false
  if (sig.turnStartTs !== null && sig.turnStartTs !== per.lastTurnStartSeen) {
    per.lastTurnStartSeen = sig.turnStartTs
    if (per.returnPending || (per.lastActivityAt > 0 && now - per.lastActivityAt >= RETURN_AFTER_MS)) returned = true
    per.returnPending = false
    per.lastActivityAt = now
    per.failureSpoken = false
  } else if (per.returnPending && !typing) {
    // A return marked by a keystroke, and the typing has paused: speak now.
    returned = true
    per.returnPending = false
  }

  // ── milestones (real events only) ─────────────────────────────────────────
  if (failFresh) per.sawFailThisTurn = true
  const prev = per.prevMood
  per.prevMood = mood
  const settled = prev !== null && prev !== 'done' && mood === 'done'
  if (settled) {
    recordCompanionMilestone(per.sawFailThisTurn ? 'recovery' : 'settle')
    per.sawFailThisTurn = false
  }

  // ── the voice ─────────────────────────────────────────────────────────────
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
      // One line per hold, whether or not the cooldown let it through.
      per.holdingSpoken = true
      speak('holding', now, typing)
    }
  } else {
    per.blockedSince = null
  }
  if (prev !== null && prev !== 'sad' && mood === 'sad' && !per.failureSpoken) {
    per.failureSpoken = true
    speak('failure', now, typing)
  }
  if (!per.bootTipDone && now - per.bootedAt >= TIP_BOOT_QUIET_MS && !sig.turnLive && !typing) {
    // The session-start tip: one attempt once the session has been quiet.
    per.bootTipDone = true
    if (per.quip === null) tryTip(now, typing)
  }

  // Expire the line.
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
  // Re-arm the clock at the cadence this state needs.
  if (listeners.size > 0) armClock(mood)
}

/**
 * `/companion tip` — one tip now, on demand. The explicit ask outranks the
 * cadence and quiet mode; the seen-tip memory still steers the pick (a
 * fresh tip first, a repeat only when every tip has been shown recently).
 * Returns the tip text, or null when the bank has nothing to say.
 */
export function requestCompanionTip(): string | null {
  ensureSessionKey()
  const now = clock()
  // On demand too, only a tip that fits the row may show.
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
    // First surface: arm the input subscriptions + clock; recompute now so
    // the first snapshot is current. The critterSleep subscription is the
    // sleep-word edge (one truth): a verdict flip re-derives the mood in
    // the same tick the art changes.
    unsubSignals = subscribeCompanionSignals(() => recompute())
    unsubSleep = subscribeCritterSleep(() => recompute())
    unsubSwitch = onSessionSwitch(() => recompute())
    recompute()
    armClock(snapshot.mood)
  }
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0) {
      // Last surface gone: tear everything down — a silent session runs no
      // hidden companion work (timers, subscriptions).
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

/** Proof seam: live resource + state counts. */
export function companionEngineStatsForProofs(): {
  listeners: number
  clockArmed: boolean
  signalsArmed: boolean
  sessionKey: string
  parkedSessions: number
  voice: VoiceState
  /** The narrowest mounted surface's budget (Infinity with none mounted). */
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

/** Proof seam: force a recompute on the engine's own clock reading. */
export function recomputeCompanionForProofs(): void {
  recompute()
}

/** Proof seam: pin the engine's clock (null restores Date.now()). */
export function setCompanionClockForProofs(next: (() => number) | null): void {
  clock = next ?? (() => Date.now())
}

/** Proof seam: hard reset (never called by product code). The fresh session
 *  boots at the engine clock's reading. */
export function resetCompanionEngineForTests(): void {
  per = freshSessionState(clock())
  parked.clear()
  sessionKey = ''
  lastTypingAt = 0
  budgets.clear()
  snapshot = { mood: 'idle', pose: toCritterState('idle'), quip: null, version: snapshot.version + 1 }
  emit()
}
