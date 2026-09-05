
export type Moment = 'settled-long' | 'holding' | 'failure' | 'silence'

export const LONG_WORK_MS = 90_000
export const HOLDING_AFTER_MS = 20_000
export const RETURN_AFTER_MS = 10 * 60_000
export const VOICE_COOLDOWN_MS = 3 * 60_000
export const INTERRUPT_GAP_MS = 60_000
export const TIP_COOLDOWN_MS = 10 * 60_000
export const TIP_SEEN_TTL_MS = 7 * 24 * 60 * 60_000
export const TIP_BOOT_QUIET_MS = 20_000
export const CONTEXT_TIP_PCT = 60

const INTERRUPTS: ReadonlySet<Moment> = new Set<Moment>(['holding', 'failure'])

export interface VoiceState {
  lastSpokeAt: number
  lastMoment: Moment | 'tip' | null
  lastLine: string | null
  lastLineByMoment: Partial<Record<Moment, string>>
  previousSettleSpoke: boolean
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

export function maySpeak(state: VoiceState, moment: Moment, now: number): boolean {
  const sinceLast = state.lastSpokeAt === 0 ? Number.POSITIVE_INFINITY : now - state.lastSpokeAt
  if (moment === 'settled-long' && state.previousSettleSpoke) return false
  if (sinceLast >= VOICE_COOLDOWN_MS) return true
  if (!INTERRUPTS.has(moment)) return false
  const lastWasInterrupt = state.lastMoment === 'holding' || state.lastMoment === 'failure'
  return !(lastWasInterrupt && sinceLast < INTERRUPT_GAP_MS)
}

export function mayTip(state: VoiceState, now: number, bootedAt: number): boolean {
  if (now - bootedAt < TIP_BOOT_QUIET_MS) return false
  const sinceLast = state.lastSpokeAt === 0 ? Number.POSITIVE_INFINITY : now - state.lastSpokeAt
  const sinceTip = state.lastTipAt === 0 ? Number.POSITIVE_INFINITY : now - state.lastTipAt
  return sinceLast >= VOICE_COOLDOWN_MS && sinceTip >= TIP_COOLDOWN_MS
}

export function noteSettle(state: VoiceState, spoke: boolean): void {
  state.previousSettleSpoke = spoke
}

export function noteSpoken(state: VoiceState, moment: Moment, line: string, now: number): void {
  state.lastSpokeAt = now
  state.lastMoment = moment
  state.lastLine = line
  state.lastLineByMoment[moment] = line
}

export function noteTip(state: VoiceState, line: string, now: number): void {
  state.lastSpokeAt = now
  state.lastTipAt = now
  state.lastMoment = 'tip'
  state.lastLine = line
}


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
  draw(pool: readonly string[], avoid: readonly (string | null | undefined)[]): string | null
}

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
      return null
    },
  }
}

export function chooseLine(deck: Deck, state: VoiceState, moment: Moment, pool: readonly string[]): string | null {
  return deck.draw(pool, [state.lastLineByMoment[moment], state.lastLine])
}


export type TipArea = 'minerva' | 'context' | 'models' | 'mcp' | 'sessions' | 'keys' | 'agents' | 'worktrees'

export interface Tip {
  id: string
  area: TipArea
  stage: 1 | 2 | 3
  text: string
  surface?: string
  when?: () => boolean
}

export interface TipSignals {
  contextPct: number | null
  openedSurfaces: ReadonlySet<string>
}

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
  const stage = Math.min(...fresh.map(t => t.stage))
  const lesson = fresh.filter(t => t.stage === stage)
  const unopened = drawFrom(lesson.filter(t => t.surface !== undefined && !signals.openedSurfaces.has(t.surface)))
  if (unopened) return unopened
  return drawFrom(lesson)
}
