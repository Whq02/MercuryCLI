import type { RequestWaitV1 } from '../../services/providers/streamIdleBudget.js'
import type { LiveTurnFactsV1 } from '../../services/engine-connector/seatLive.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { formatDuration, formatTokens } from '../../utils/format.js'
import { formatQuietAge } from '../../tools/WorkflowTool/livePulse.js'

export type LiveCounterPhase = 'thinking' | 'writing' | 'working' | 'waiting'

export interface LiveCounterFacts extends LiveTurnFactsV1 {
  phase: LiveCounterPhase
  sentAtMs: number | null
}

export interface LiveCounterFigure {
  total: number
  thinking: number
  reply: number
  estimated: boolean
}

export interface LiveCounterWords {
  figure: LiveCounterFigure
  count: string | null
  countShort: string | null
  reading: boolean
  phase: string
  clock: string
  pulse: string | null
  promise: string | null
}

export const LIVE_CHARS_PER_TOKEN = 4
export const READING_PHASE_WORD = 'reading the prompt'
export const LOADING_PHASE_WORD = 'loading the model'
export const RETRY_PHASE_WORD = 'retrying'

const tokensOf = (chars: number): number => Math.floor(Math.max(0, Number.isFinite(chars) ? chars : 0) / LIVE_CHARS_PER_TOKEN)

export function liveCounterFigure(facts: Pick<LiveTurnFactsV1, 'replyChars' | 'thinkingChars' | 'wireOutputTokens'>): LiveCounterFigure {
  const thinking = tokensOf(facts.thinkingChars)
  const reply = tokensOf(facts.replyChars)
  const estimate = thinking + reply
  const wire = facts.wireOutputTokens !== null && Number.isFinite(facts.wireOutputTokens) ? Math.max(0, Math.floor(facts.wireOutputTokens)) : null
  if (wire !== null && wire > 0 && wire >= estimate) return { total: wire, thinking: 0, reply: wire, estimated: false }
  return { total: estimate, thinking, reply, estimated: true }
}

export function liveCountWords(figure: LiveCounterFigure): { long: string; short: string } | null {
  if (figure.total <= 0) return null
  const count = `↓ ${figure.estimated ? '~' : ''}${formatTokens(figure.total)}`
  return { long: count, short: count }
}

export function liveCounterPulse(facts: Pick<LiveTurnFactsV1, 'lastByteAtMs'>, phase: string, nowMs: number): string | null {
  if (phase !== 'thinking' || typeof facts.lastByteAtMs !== 'number' || !Number.isFinite(facts.lastByteAtMs)) return null
  return `↻${formatQuietAge(Math.max(0, nowMs - facts.lastByteAtMs))}`
}

export function liveCounterPromise(wait: RequestWaitV1 | null, _nowMs: number): string | null {
  if (wait?.kind !== 'retry') return null
  return `${wait.reconnecting ? 'reconnecting' : 'retrying'} ${wait.attempt} of ${wait.of}`
}

export function liveCounterWords(facts: LiveCounterFacts, nowMs: number): LiveCounterWords {
  const figure = liveCounterFigure(facts)
  const wait = facts.wait
  const reading = wait !== null && wait.kind === 'first-byte'
  const phase = reading
    ? wait.prefillMs !== undefined
      ? `reading ${Math.round(wait.promptTokens / 1000)}k tokens of context`
      : wait.phase === 'tokens'
        ? 'waiting for the first token'
        : wait.phase === 'loading' ? LOADING_PHASE_WORD : READING_PHASE_WORD
    : wait !== null && wait.kind === 'retry'
      ? wait.reconnecting ? 'reconnecting' : RETRY_PHASE_WORD
      : facts.phase === 'waiting' || facts.phase === 'thinking' && facts.firstByteAtMs === null && figure.total === 0 && !facts.thinkingBlocks ? 'waiting for the first token' : facts.phase
  const count = liveCountWords(figure)
  const knownZero = facts.wireOutputTokens === 0 || facts.firstByteAtMs === null && facts.replyChars === 0 && facts.thinkingChars === 0 && !facts.thinkingBlocks
  const clock = facts.sentAtMs === null ? '' : formatDuration(Math.max(0, nowMs - facts.sentAtMs))
  return {
    figure,
    count: count?.long ?? (knownZero ? '↓ 0' : null),
    countShort: count?.short ?? (knownZero ? '↓ 0' : null),
    reading,
    phase,
    clock,
    pulse: liveCounterPulse(facts, phase, nowMs),
    promise: liveCounterPromise(wait, nowMs),
  }
}

export function liveCounterSegments(words: LiveCounterWords, count: string | null = words.count): string[] {
  return [words.clock, count ?? '', words.promise ?? ''].filter(segment => segment !== '')
}

export function liveCounterLine(words: LiveCounterWords, budget: number, separator = ' · ', otps = 0): string {
  const ladder: string[][] = [
    [words.clock, words.count ?? '', otps >= 1 ? `~${otps} tok/s` : '', words.promise ?? ''],
    liveCounterSegments(words),
    ...(words.promise !== null ? [[words.clock, words.promise], [words.promise]] : []),
    [words.clock, words.countShort ?? ''],
    [words.clock],
  ]
  for (const rung of ladder) {
    const parts = rung.filter(segment => segment !== '')
    if (parts.length === 0) continue
    const line = parts.join(separator)
    if (stringWidth(line) <= budget) return line
  }
  return ''
}

export function turnFactsOfRefs(streamedChars: number, wireOutputTokens: number | null): LiveTurnFactsV1 {
  return { replyChars: Math.max(0, streamedChars), thinkingChars: 0, wireOutputTokens, firstByteAtMs: null, wait: null }
}

export function liveCounterPhaseOf(mode: string): LiveCounterPhase {
  if (mode === 'thinking') return 'thinking'
  if (mode === 'responding') return 'writing'
  if (mode === 'tool-use' || mode === 'tool-input') return 'working'
  return 'waiting'
}
