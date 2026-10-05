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
const tokenWord = (n: number): string => (n === 1 ? 'token' : 'tokens')
const budgetWords = (ms: number): string => formatDuration(Math.max(1000, Math.round(ms / 1000) * 1000), { hideTrailingZeros: true })

export function liveCounterFigure(facts: Pick<LiveTurnFactsV1, 'replyChars' | 'thinkingChars' | 'wireOutputTokens'>): LiveCounterFigure {
  const thinking = tokensOf(facts.thinkingChars)
  const reply = tokensOf(facts.replyChars)
  const estimate = thinking + reply
  const wire = facts.wireOutputTokens !== null && Number.isFinite(facts.wireOutputTokens) ? Math.max(0, Math.floor(facts.wireOutputTokens)) : null
  if (wire !== null && wire > 0 && wire >= estimate) return { total: wire, thinking: 0, reply: wire, estimated: false }
  return { total: estimate, thinking, reply, estimated: true }
}

export function liveCountWords(figure: LiveCounterFigure, thinkingBlocks = 0): { long: string; short: string } | null {
  const blocks = figure.thinking === 0 && thinkingBlocks > 0 ? `${thinkingBlocks} thinking ${thinkingBlocks === 1 ? 'block' : 'blocks'}` : null
  if (figure.total <= 0) return blocks === null ? null : { long: `↓ ${blocks}`, short: `↓ ${blocks}` }
  const short = `↓ ${figure.estimated ? '~' : ''}${formatTokens(figure.total)} ${tokenWord(figure.total)}`
  if (!figure.estimated || figure.thinking === 0) return { long: blocks === null ? short : `${short} · ${blocks}`, short }
  if (figure.reply === 0) return { long: `↓ ~${formatTokens(figure.thinking)} thinking ${tokenWord(figure.thinking)}`, short }
  return { long: `↓ ~${formatTokens(figure.thinking)} thinking · ${formatTokens(figure.reply)} ${tokenWord(figure.reply)}`, short }
}

export function liveCounterPulse(facts: Pick<LiveTurnFactsV1, 'lastByteAtMs'>, phase: string, nowMs: number): string | null {
  if (phase !== 'thinking' || typeof facts.lastByteAtMs !== 'number' || !Number.isFinite(facts.lastByteAtMs)) return null
  return `↻${formatQuietAge(Math.max(0, nowMs - facts.lastByteAtMs))}`
}

export function liveCounterPromise(wait: RequestWaitV1 | null, nowMs: number): string | null {
  if (wait === null) return null
  if (wait.kind === 'first-byte') {
    if (wait.phase === 'loading') return `${wait.model}${wait.sizeGb !== undefined ? ` (${wait.sizeGb} GB)` : ''}`
    const again = wait.attempt > 1 ? ` (attempt ${wait.attempt})` : ''
    if (nowMs - wait.sinceMs > wait.budgetMs) return `past the ${budgetWords(wait.budgetMs)} first-byte budget${again}`
    return `first byte expected within ${budgetWords(wait.budgetMs)}${again}`
  }
  if (wait.kind === 'retry') {
    return `attempt ${wait.attempt} of ${wait.of} after ${wait.reason}${wait.delayMs > 0 ? ` · in ${budgetWords(wait.delayMs)}` : ''}`
  }
  return `no bytes for ${budgetWords(wait.silentMs)}${wait.answered ? ' — the server still answers' : ''}`
}

export function liveCounterWords(facts: LiveCounterFacts, nowMs: number): LiveCounterWords {
  const figure = liveCounterFigure(facts)
  const wait = facts.wait
  const reading = wait !== null && wait.kind === 'first-byte' && facts.firstByteAtMs === null
  const phase = reading
    ? wait.phase === 'loading'
      ? LOADING_PHASE_WORD
      : READING_PHASE_WORD
    : wait !== null && wait.kind === 'retry'
      ? RETRY_PHASE_WORD
      : facts.phase
  const count = liveCountWords(figure, phase === 'thinking' ? (facts.thinkingBlocks ?? 0) : 0)
  const clock = facts.sentAtMs === null ? '' : formatDuration(Math.max(0, nowMs - facts.sentAtMs))
  return {
    figure,
    count: count?.long ?? null,
    countShort: count?.short ?? null,
    reading,
    phase,
    clock,
    pulse: liveCounterPulse(facts, phase, nowMs),
    promise: liveCounterPromise(wait, nowMs),
  }
}

export function liveCounterSegments(words: LiveCounterWords, count: string | null = words.count): string[] {
  return [count ?? '', words.pulse ?? '', words.phase, words.clock, words.promise ?? ''].filter(segment => segment !== '')
}

export function liveCounterLine(words: LiveCounterWords, budget: number, separator = ' · '): string {
  const ladder: string[][] = [
    liveCounterSegments(words),
    [words.count ?? '', words.pulse ?? '', words.phase, words.clock],
    [words.countShort ?? '', words.pulse ?? '', words.phase, words.clock],
    [words.countShort ?? '', words.phase, words.clock],
    [words.countShort ?? '', words.clock],
    [words.phase, words.clock],
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
