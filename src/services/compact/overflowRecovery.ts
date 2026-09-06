import { flagEnabled } from '../../substrate/flagRegistry.js'
import type { Message } from '../../types/message.js'
import { isTurnOwningQuerySource } from '../../utils/effort.js'
import { PROMPT_TOO_LONG_ERROR_MESSAGE } from '../api/errors.js'
import {
  type OverflowSignal,
  overflowGapTokens,
  overflowNumbersClause,
} from '../api/overflowSignal.js'
import { providerDisplayName } from '../providers/routeLaw.js'
import { isAutoCompactEnabled, type AutoCompactTrackingState } from './autoCompact.js'
import { compactionBreakerAllows } from './compactionPolicy.js'

export const OVERFLOW_RECOVERY_FLAG = 'MERCURY_OVERFLOW_RECOVERY'

export function overflowRecoveryEnabled(): boolean {
  return flagEnabled(OVERFLOW_RECOVERY_FLAG)
}

export function overflowLadderArmed(querySource: string | undefined): boolean {
  return overflowRecoveryEnabled() && isTurnOwningQuerySource(querySource)
}

export type OverflowEpisode = { readonly pruned: boolean; readonly folded: boolean }
export const FRESH_OVERFLOW_EPISODE: OverflowEpisode = Object.freeze({ pruned: false, folded: false })

export const PRUNE_COVER_MARGIN = 1.2

export type FoldUnavailableWhy =
  | 'compaction-off'
  | 'auto-compact-off'
  | 'breaker'
  | 'single-message'
  | 'fold-failed'
  | 'fold-did-not-land'

export type FoldAvailability =
  | { available: true }
  | { available: false; why: FoldUnavailableWhy; detail?: string }

export function foldAvailability(input: {
  tracking: AutoCompactTrackingState | undefined
  headFold?: 'failed' | 'did-not-land'
  headFoldDetail?: string
  hasHistory: boolean
}): FoldAvailability {
  if (!flagEnabled('MERCURY_COMPACT')) return { available: false, why: 'compaction-off' }
  if (!isAutoCompactEnabled()) return { available: false, why: 'auto-compact-off' }
  if (!compactionBreakerAllows(input.tracking?.consecutiveFailures)) return { available: false, why: 'breaker' }
  if (input.headFold === 'failed') {
    return { available: false, why: 'fold-failed', ...(input.headFoldDetail !== undefined ? { detail: input.headFoldDetail } : {}) }
  }
  if (input.headFold === 'did-not-land') return { available: false, why: 'fold-did-not-land' }
  if (!input.hasHistory) return { available: false, why: 'single-message' }
  return { available: true }
}

export type OverflowRung = 'prune' | 'fold'

export type OverflowDecision =
  | { kind: 'recover'; rung: OverflowRung }
  | { kind: 'refuse'; why: FoldUnavailableWhy | 'retry-overflowed'; detail?: string }

export function decideOverflowRecovery(input: {
  episode: OverflowEpisode
  gapTokens: number | undefined
  pruneSavingTokens: number
  fold: FoldAvailability
}): OverflowDecision {
  const { episode, gapTokens, pruneSavingTokens, fold } = input
  if (
    !episode.pruned &&
    gapTokens !== undefined &&
    pruneSavingTokens > 0 &&
    pruneSavingTokens >= gapTokens * PRUNE_COVER_MARGIN
  ) {
    return { kind: 'recover', rung: 'prune' }
  }
  if (!episode.folded && fold.available) return { kind: 'recover', rung: 'fold' }
  if (episode.folded) return { kind: 'refuse', why: 'retry-overflowed' }
  if (fold.available) return { kind: 'refuse', why: 'retry-overflowed' }
  return { kind: 'refuse', why: fold.why, ...(fold.detail !== undefined ? { detail: fold.detail } : {}) }
}

export function splitCarriedOperatorTail(messages: readonly Message[]): {
  head: Message[]
  carry: Message[]
  hasHistory: boolean
} {
  let lastAssistant = -1
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.type === 'assistant') {
      lastAssistant = index
      break
    }
  }
  const tail = messages.slice(lastAssistant + 1)
  const isOperatorTurn = (m: Message): boolean => {
    if (m.type !== 'user') return false
    const user = m as { isMeta?: boolean; message: { content: unknown } }
    if (user.isMeta === true) return false
    const content = user.message.content
    if (typeof content === 'string') return true
    if (!Array.isArray(content)) return false
    return !content.some(block => (block as { type?: string }).type === 'tool_result')
  }
  const hasToolResult = tail.some(
    m =>
      m.type === 'user' &&
      Array.isArray((m as { message: { content: unknown } }).message.content) &&
      ((m as { message: { content: Array<{ type?: string }> } }).message.content).some(b => b.type === 'tool_result'),
  )
  const operatorTurns = tail.filter(isOperatorTurn)
  if (hasToolResult || operatorTurns.length !== 1) {
    return { head: [...messages], carry: [], hasHistory: lastAssistant !== -1 }
  }
  const head = messages.slice(0, lastAssistant + 1)
  return { head, carry: tail, hasHistory: lastAssistant !== -1 }
}


export function overflowWhoClause(signal: OverflowSignal): string {
  const numbers = overflowNumbersClause(signal)
  if (signal.source === 'estimate') return numbers !== undefined ? `estimated ${numbers}` : 'by estimate'
  const who = signal.family === 'unknown' ? 'the provider' : providerDisplayName(signal.family)
  return numbers !== undefined ? `${who}: ${numbers}` : who
}

export function overflowRecoveryNotice(
  signal: OverflowSignal,
  rung: OverflowRung,
  pruned?: { cleared: number; tokensSaved: number },
): string {
  const head = `context overflowed (${overflowWhoClause(signal)})`
  if (rung === 'fold') return `${head} — folding the conversation and retrying`
  const n = pruned?.cleared ?? 0
  const saved = pruned?.tokensSaved ?? 0
  return `${head} — pruned ${n} superseded tool result${n === 1 ? '' : 's'} (~${saved.toLocaleString('en-US')} tokens) and retrying`
}

export function overflowRefusalText(
  signal: OverflowSignal,
  why: FoldUnavailableWhy | 'retry-overflowed',
  opts: { nonInteractive: boolean; detail?: string },
): string {
  const who = overflowWhoClause(signal)
  const refusedBy =
    signal.source === 'estimate'
      ? `the request is over the window (${who})`
      : `the request overflowed the window (${who})`
  const remedy = opts.nonInteractive
    ? 'Start a fresh run, or pass --model with a larger window.'
    : '/clear starts fresh, or /model picks a model with a larger window.'
  const byHand = opts.nonInteractive ? '' : ' /compact folds the conversation by hand;'
  const tried = ((): string => {
    switch (why) {
      case 'retry-overflowed':
        return 'the conversation was folded and the request retried once, and it still overflows.'
      case 'compaction-off':
        return 'compaction is disabled (MERCURY_COMPACT=0), so nothing could fold.'
      case 'auto-compact-off':
        return `automatic compaction is off, so the emergency fold did not run.${byHand}`
      case 'breaker':
        return 'compaction has failed repeatedly and is paused for this session.'
      case 'fold-failed':
        return `the fold failed${opts.detail !== undefined && opts.detail !== '' ? ` (${opts.detail})` : ''}.${byHand}`
      case 'fold-did-not-land':
        return `the fold did not bring the conversation under the window.${byHand}`
      case 'single-message':
        return 'this message alone is larger than the window — shorten or split it.'
    }
  })()
  return `${PROMPT_TOO_LONG_ERROR_MESSAGE} — ${refusedBy}: ${tried} ${remedy}`
}

export function overflowGapFor(signal: OverflowSignal): number | undefined {
  return overflowGapTokens(signal)
}
