// ============================================================================
//  utils/cockpit/companionVoice — WHEN the companion speaks, and WHICH line.
//
//  Pure law: a clock and the real moments in, a decision out. The engine
//  (companionEngine) observes the moments from the live seams and asks this
//  module; nothing here reads time, state or files itself, so the prover
//  walks every rule on a pinned clock.
//
//  THE MOMENTS — four, each with its own pool of lines:
//    · settled-long — a turn settled after LONG_WORK_MS of live work; a short
//      reply never speaks.
//    · holding      — a permission has waited on the operator HOLDING_AFTER_MS.
//    · failure      — the turn's content-derived verdict is failed.
//    · silence      — the operator returns after RETURN_AFTER_MS of quiet.
//
//  THE CADENCE — consecutive settles never both speak (a settle that follows
//  a spoken settle is silent by rule, however long it ran), and any two lines
//  sit VOICE_COOLDOWN_MS apart. `holding` and `failure` are about the
//  operator's attention: they may interrupt the cooldown, but not each other
//  within INTERRUPT_GAP_MS.
//
//  THE DECK — seeded per session (the profile seed + the species + the
//  session id), a shuffled deck per pool refilled on exhaustion: never the
//  same line twice in a row for a moment, never the line spoken last
//  overall, and never a fixed rotation the operator learns. Pinned seeds make
//  it reproducible.
//
//  TIPS ride the same voice on QUIET moments (a session start, a return, a
//  long run that settled without a moment line): at most one per
//  TIP_COOLDOWN_MS, a shown tip stays away TIP_SEEN_TTL_MS, situational
//  first where a signal exists.
// ============================================================================

export type Moment = 'settled-long' | 'holding' | 'failure' | 'silence'

/** A turn must have run this long, live, for its settle to speak. */
export const LONG_WORK_MS = 90_000
/** A permission must have waited this long before the companion mentions it. */
export const HOLDING_AFTER_MS = 20_000
/** Quiet this long, then a return, is the silence moment. */
export const RETURN_AFTER_MS = 10 * 60_000
/** Any two lines sit at least this far apart. */
export const VOICE_COOLDOWN_MS = 3 * 60_000
/** holding/failure may interrupt the cooldown, but not each other within this. */
export const INTERRUPT_GAP_MS = 60_000
/** At most one tip per this. */
export const TIP_COOLDOWN_MS = 10 * 60_000
/** A shown tip does not return for this long. */
export const TIP_SEEN_TTL_MS = 7 * 24 * 60 * 60_000
/** A session needs to be quiet this long after boot before the first tip. */
export const TIP_BOOT_QUIET_MS = 20_000
/** The context meter past this percent prefers a context tip. */
export const CONTEXT_TIP_PCT = 60

const INTERRUPTS: ReadonlySet<Moment> = new Set<Moment>(['holding', 'failure'])

/** The per-session voice state the engine keeps (and parks across switches). */
export interface VoiceState {
  /** Epoch ms of the last line (moment line or tip); 0 before any. */
  lastSpokeAt: number
  lastMoment: Moment | 'tip' | null
  /** The last line spoken overall (no immediate repeat across moments). */
  lastLine: string | null
  /** The last line per moment (no immediate repeat within a moment). */
  lastLineByMoment: Partial<Record<Moment, string>>
  /** Did the PREVIOUS settle speak? Consecutive settles never both speak. */
  previousSettleSpoke: boolean
  /** Epoch ms of the last tip; 0 before any. */
  lastTipAt: number
}

export function freshVoiceState(): VoiceState {
  return {
    lastSpokeAt: 0,
    lastMoment: null,
    lastLine: null,
    lastLineByMoment: {},
    previousSettleSpoke: false,
    lastTipAt: 0,
  }
}

/** May a line for `moment` be spoken at `now`? Pure. */
export function maySpeak(state: VoiceState, moment: Moment, now: number): boolean {
  const sinceLast = state.lastSpokeAt === 0 ? Number.POSITIVE_INFINITY : now - state.lastSpokeAt
  if (moment === 'settled-long' && state.previousSettleSpoke) return false
  if (sinceLast >= VOICE_COOLDOWN_MS) return true
  if (!INTERRUPTS.has(moment)) return false
  // An interrupt may cut the cooldown — unless the last line was itself an
  // interrupt within the gap (two attention lines never stack).
  const lastWasInterrupt = state.lastMoment === 'holding' || state.lastMoment === 'failure'
  return !(lastWasInterrupt && sinceLast < INTERRUPT_GAP_MS)
}

/** May a tip be shown at `now`? Tips share the voice cooldown and add their own. */
export function mayTip(state: VoiceState, now: number, bootedAt: number): boolean {
  if (now - bootedAt < TIP_BOOT_QUIET_MS) return false
  const sinceLast = state.lastSpokeAt === 0 ? Number.POSITIVE_INFINITY : now - state.lastSpokeAt
  const sinceTip = state.lastTipAt === 0 ? Number.POSITIVE_INFINITY : now - state.lastTipAt
  return sinceLast >= VOICE_COOLDOWN_MS && sinceTip >= TIP_COOLDOWN_MS
}

/** Record a settle — spoken or not — so the consecutive-settle rule holds. */
export function noteSettle(state: VoiceState, spoke: boolean): void {
  state.previousSettleSpoke = spoke
}

/** Record a spoken moment line. */
export function noteSpoken(state: VoiceState, moment: Moment, line: string, now: number): void {
  state.lastSpokeAt = now
  state.lastMoment = moment
  state.lastLine = line
  state.lastLineByMoment[moment] = line
}

/** Record a shown tip. */
export function noteTip(state: VoiceState, line: string, now: number): void {
  state.lastSpokeAt = now
  state.lastTipAt = now
  state.lastMoment = 'tip'
  state.lastLine = line
}

// ── the deck ────────────────────────────────────────────────────────────────

function fnv1a(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Deck {
  /**
   * Draw one card from `pool` that is not in `avoid`. Each distinct pool
   * (by its joined contents) keeps its own shuffled order; when the order
   * runs out it reshuffles, never starting the new order on the card drawn
   * last. Returns null only when every card is avoided.
   */
  draw(pool: readonly string[], avoid: readonly (string | null | undefined)[]): string | null
}

/** A seeded deck — the same seed draws the same sequence, forever. */
export function createDeck(seed: string): Deck {
  const rng = mulberry32(fnv1a(seed))
  const orders = new Map<string, { order: string[]; cursor: number; last: string | null }>()
  const shuffle = (pool: readonly string[], notFirst: string | null): string[] => {
    const cards = [...pool]
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      ;[cards[i], cards[j]] = [cards[j]!, cards[i]!]
    }
    if (cards.length > 1 && cards[0] === notFirst) {
      const k = 1 + Math.floor(rng() * (cards.length - 1))
      ;[cards[0], cards[k]] = [cards[k]!, cards[0]!]
    }
    return cards
  }
  return {
    draw(pool, avoid) {
      if (pool.length === 0) return null
      const key = pool.join('\0')
      let entry = orders.get(key)
      if (!entry) {
        entry = { order: shuffle(pool, null), cursor: 0, last: null }
        orders.set(key, entry)
      }
      const blocked = new Set(avoid.filter((a): a is string => typeof a === 'string'))
      // Walk forward for the first card not blocked; reshuffle when exhausted.
      for (let attempts = 0; attempts < pool.length * 2 + 2; attempts++) {
        if (entry.cursor >= entry.order.length) {
          entry.order = shuffle(pool, entry.last)
          entry.cursor = 0
        }
        const card = entry.order[entry.cursor]!
        entry.cursor += 1
        if (!blocked.has(card)) {
          entry.last = card
          return card
        }
      }
      // Every card is blocked (a pool of one, avoided): honest silence.
      return null
    },
  }
}

/** The line for a moment: draws from the moment's pool, avoiding the moment's
 *  last line and the last line overall. Null ⇒ nothing to say. */
export function chooseLine(deck: Deck, state: VoiceState, moment: Moment, pool: readonly string[]): string | null {
  return deck.draw(pool, [state.lastLineByMoment[moment], state.lastLine])
}

// ── tips ────────────────────────────────────────────────────────────────────

export type TipArea = 'minerva' | 'context' | 'models' | 'mcp' | 'sessions' | 'keys' | 'agents' | 'worktrees'

export interface Tip {
  /** Stable id (the seen-tip memory keys on it). */
  id: string
  area: TipArea
  /** ≤ 40 cells, plain words, no exclamation marks, no emoji. */
  text: string
  /** The surface this tip teaches (a slash-command name); a surface the
   *  operator has never opened ranks its tip first. */
  surface?: string
  /** Situational availability (the fast-mode tip only while fast mode is on). */
  when?: () => boolean
}

export interface TipSignals {
  /** The context meter, percent used — null when unknown. */
  contextPct: number | null
  /** Slash commands the operator has opened (ever, from the profile). */
  openedSurfaces: ReadonlySet<string>
}

/**
 * Pick a tip: situational first (the context meter past CONTEXT_TIP_PCT
 * prefers a context tip; a surface never opened prefers its tip), then the
 * whole bank; a tip seen within TIP_SEEN_TTL_MS is skipped. With
 * `allowSeen` (an explicit ask) the seen filter relaxes when nothing fresh
 * remains. Pure.
 */
export function pickTip(
  deck: Deck,
  state: VoiceState,
  tips: readonly Tip[],
  seen: Readonly<Record<string, number>>,
  signals: TipSignals,
  now: number,
  allowSeen = false,
): Tip | null {
  const available = tips.filter(t => !(t.when && !t.when()))
  let fresh = available.filter(t => {
    const shownAt = seen[t.id]
    return shownAt === undefined || now - shownAt >= TIP_SEEN_TTL_MS
  })
  if (fresh.length === 0 && allowSeen) fresh = available
  if (fresh.length === 0) return null
  const byText = new Map(fresh.map(t => [t.text, t]))
  const drawFrom = (pool: Tip[]): Tip | null => {
    if (pool.length === 0) return null
    const text = deck.draw(
      pool.map(t => t.text),
      [state.lastLine],
    )
    return text === null ? null : (byText.get(text) ?? null)
  }
  if (signals.contextPct !== null && signals.contextPct >= CONTEXT_TIP_PCT) {
    const contextual = drawFrom(fresh.filter(t => t.area === 'context'))
    if (contextual) return contextual
  }
  const unopened = drawFrom(fresh.filter(t => t.surface !== undefined && !signals.openedSurfaces.has(t.surface)))
  if (unopened) return unopened
  return drawFrom(fresh)
}
