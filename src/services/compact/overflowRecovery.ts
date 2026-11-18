import { flagEnabled } from '../../substrate/flagRegistry.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { isTurnOwningQuerySource } from '../../utils/effort.js'
import { API_ERROR_MESSAGE_PREFIX } from '../api/errorPrefix.js'
import { PROMPT_TOO_LONG_ERROR_MESSAGE } from '../api/errors.js'
import {
  type OverflowSignal,
  overflowGapTokens,
  overflowWhoClause,
  NEAR_WINDOW_SHARE,
} from '../api/overflowSignal.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import { autoCompactDisabledReason, COMPACTION_PAUSED_KEY, compactionBreakerText, compactionSettingsText, getAutoCompactThreshold, rapidRefillPauseText, resolveAutoCompactWindow, type AutoCompactTrackingState } from './autoCompact.js'
import { FOLD_WINDOW_REFUSAL_KEY } from './compact.js'
import { compactionBreakerAllows } from './compactionPolicy.js'

export function overflowLadderArmed(querySource: string | undefined): boolean {
  return isTurnOwningQuerySource(querySource)
}

export type OverflowEpisode = { readonly pruned: boolean; readonly folded: boolean }
export const FRESH_OVERFLOW_EPISODE: OverflowEpisode = Object.freeze({ pruned: false, folded: false })

export const PRUNE_COVER_MARGIN = 1.2

export type FoldUnavailableWhy =
  | 'compaction-off'
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
  if (input.tracking?.rapidRefillPaused === true) return { available: false, why: 'breaker', detail: 'rapid-refill' }
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
  pruneAllowed?: boolean
  fold: FoldAvailability
}): OverflowDecision {
  const { episode, gapTokens, pruneSavingTokens, fold } = input
  if (!episode.folded && fold.available) return { kind: 'recover', rung: 'fold' }
  if (
    input.pruneAllowed === true &&
    !episode.pruned &&
    (fold.available || fold.why !== 'compaction-off') &&
    gapTokens !== undefined &&
    pruneSavingTokens > 0 &&
    pruneSavingTokens >= gapTokens * PRUNE_COVER_MARGIN
  ) {
    return { kind: 'recover', rung: 'prune' }
  }
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


export { overflowMeasuredClause, overflowWhoClause } from '../api/overflowSignal.js'

export { foldRemedyIsHeadless } from './compact.js'

function plainDetail(detail: string | undefined): string {
  if (detail === undefined) return ''
  const prefix = `${API_ERROR_MESSAGE_PREFIX}: `
  return (detail.startsWith(prefix) ? detail.slice(prefix.length) : detail).trim()
}

export function measureOverflow(signal: OverflowSignal, messages: readonly Message[], model: string): OverflowSignal {
  if (signal.measuredTokens !== undefined && signal.measuredWindow !== undefined) return signal
  return {
    ...signal,
    measuredTokens: tokenCountWithEstimation(messages, model),
    measuredWindow: resolveAutoCompactWindow(model).window,
  }
}

const SIZE_WARNING_SHARE = NEAR_WINDOW_SHARE

export function requestSizeWarning(messages: readonly Message[], model: string): string | null {
  const tokens = tokenCountWithEstimation(messages, model)
  const window = resolveAutoCompactWindow(model).window
  if (!(window > 0) || tokens < Math.floor(window * SIZE_WARNING_SHARE)) return null
  const fmt = (n: number): string => n.toLocaleString('en-US')
  const size = `about ${fmt(tokens)} of the model's ${fmt(window)}-token window by Mercury's count`
  const next = autoCompactDisabledReason() === null && tokens >= getAutoCompactThreshold(model)
    ? 'Mercury folds it before the next request'
    : '/compact folds it by hand'
  return `the request failed and this conversation is near the window (${size}) — a request this size can be refused; ${next}`
}

const SIZE_WARNING_SILENT_CLASSES: ReadonlySet<string> = new Set(['rate_limit', 'billing_error', 'authentication_failed', 'invalid_request', 'max_output_tokens'])
const UNCLASSIFIED_RATE_LIMIT_FRAME = new RegExp(`^${API_ERROR_MESSAGE_PREFIX} \\(429[,)]`)

export function requestSizeWarningApplies(row: Pick<AssistantMessage, 'error' | 'overflowSignal' | 'providerWaitEndsAtMs' | 'message'>): boolean {
  if (row.overflowSignal !== undefined) return true
  if (row.providerWaitEndsAtMs !== undefined) return false
  if (row.error !== undefined && SIZE_WARNING_SILENT_CLASSES.has(row.error)) return false
  const content = row.message.content
  const text = typeof content === 'string' ? content : (content.find(block => block.type === 'text') as { text?: string } | undefined)?.text ?? ''
  return !UNCLASSIFIED_RATE_LIMIT_FRAME.test(text)
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
  return `${head} — pruned ${n} superseded tool-result bod${n === 1 ? 'y' : 'ies'} (about ${saved.toLocaleString('en-US')} tokens by Mercury's estimate, net of placeholders; no summary written, nothing moved to memory) and retrying`
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
      case 'breaker':
        return opts.detail === 'rapid-refill' ? rapidRefillPauseText({ nonInteractive: opts.nonInteractive }) : compactionBreakerText({ nonInteractive: opts.nonInteractive })
      case 'fold-failed': {
        const detail = plainDetail(opts.detail)
        if (detail.startsWith(COMPACTION_PAUSED_KEY)) return detail
        if (detail.startsWith(FOLD_WINDOW_REFUSAL_KEY)) return `${detail}${byHand}`
        return `the fold failed${detail !== '' ? ` (${detail})` : ''}. The conversation is kept whole; nothing moved.${byHand}`
      }
      case 'fold-did-not-land':
        return `the fold did not bring the conversation under the window; it is kept whole and nothing moved.${byHand}`
      case 'single-message':
        return 'this message alone is larger than the window — shorten or split it.'
    }
  })()
  const off = autoCompactDisabledReason()
  const settings = off !== null && why !== 'compaction-off' ? ` ${compactionSettingsText()}.` : ''
  return `${PROMPT_TOO_LONG_ERROR_MESSAGE} — ${refusedBy}: ${tried}${settings} ${remedy}`
}

export function overflowGapFor(signal: OverflowSignal): number | undefined {
  return overflowGapTokens(signal)
}
