// ============================================================================
//  compact/overflowRecovery — the context-overflow recovery ladder's policy.
//
//  A request that does not fit the window used to END THE TURN: the pre-call
//  estimate returned a bare "Prompt is too long", a provider's refusal fell
//  through to the API-error return, and in a headless, delegated or seat
//  child run nobody was there to type /compact. An overflow is now a typed
//  event (services/api/overflowSignal.ts) the turn machine answers with a
//  bounded, ordered ladder:
//
//    rung 1 · PRUNE — when the speaker named the gap and clearing the
//             superseded tool results outside the keep-recent window
//             (the landed time-based clearing walk, its protections and
//             its placeholder) covers it, prune and retry — mechanical, no
//             model call, the prose of the conversation untouched;
//    rung 2 · FOLD  — the landed mechanical compaction on the SAME session
//             (identity untouched), the operator's just-sent message carried
//             VERBATIM around the fold, then the same request retried once;
//    rung 3 · REFUSE — typed: what was tried, the numbers, the exact remedy
//             (/compact by hand · /clear · a larger-window model via /model),
//             never a raw provider sentence, never a silent dropped message.
//
//  Bounds: each rung at most once per EPISODE (a completed tool round is
//  real progress and opens a new one — the stream-fault precedent; the
//  rapid-refill breaker still ends a fold-refill-fold thrash). The fold
//  respects every landed compaction switch: DISABLE_COMPACT kills the whole
//  arm, DISABLE_AUTO_COMPACT / the config toggle keep the fold off (the
//  operator asked for no automatic folds — the refusal names /compact), the
//  consecutive-failure breaker stands. The compact and session_memory forks
//  never enter (they exist to shrink the conversation; recovering them would
//  deadlock). This module is PURE apart from the flag/config reads named in
//  the two predicates; the turn machine owns the sequencing.
// ============================================================================
import { flagEnabled } from '../../substrate/flagRegistry.js'
import type { Message } from '../../types/message.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
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

/** The registered default-on gate; =0 restores the pre-ladder surface. */
export function overflowRecoveryEnabled(): boolean {
  return flagEnabled(OVERFLOW_RECOVERY_FLAG)
}

/** The ladder rides turn-owning runs only — the REPL, the SDK/headless run,
 *  delegated agents. Service forks (the compact and session-memory
 *  summaries, classifiers, side questions) keep today's surface: their
 *  errors answer their own callers. */
export function overflowLadderArmed(querySource: string | undefined): boolean {
  return overflowRecoveryEnabled() && isTurnOwningQuerySource(querySource)
}

/** One episode = the run between two completed tool rounds. */
export type OverflowEpisode = { readonly pruned: boolean; readonly folded: boolean }
export const FRESH_OVERFLOW_EPISODE: OverflowEpisode = Object.freeze({ pruned: false, folded: false })

/** The prune's estimated saving must beat the named gap by this factor:
 *  the clearing walk counts characters/4, the provider counts its own
 *  tokens, and a prune that lands a hair short costs a whole extra
 *  refusal round-trip before the fold runs. */
export const PRUNE_COVER_MARGIN = 1.2

export type FoldUnavailableWhy =
  | 'compaction-off'
  | 'auto-compact-off'
  | 'breaker'
  | 'single-message'
  | 'fold-failed'
  /** The estimate side: the loop head's own fold already had its turn
   *  this iteration (it ran and the view is still over, or the operator
   *  cancelled it) — the ladder never forces it a second time. */
  | 'fold-did-not-land'

export type FoldAvailability =
  | { available: true }
  | { available: false; why: FoldUnavailableWhy; detail?: string }

/** Why the fold rung may or may not run right now — every reason is one the
 *  refusal sentence can name. `headFoldFailed`: the loop head's own
 *  auto-compaction already tried and failed this iteration (forcing it
 *  again would only repeat the failure). `hasHistory`: the fold input holds
 *  at least one assistant turn beside the carried operator message — a
 *  lone message larger than the window cannot be folded smaller. */
export function foldAvailability(input: {
  tracking: AutoCompactTrackingState | undefined
  /** The loop head's own fold already had its turn this iteration: 'failed'
   *  when a failure was recorded (consecutiveFailures grew), 'did-not-land'
   *  when it simply left the view over the limit (the estimate side never
   *  forces a second fold either way). */
  headFold?: 'failed' | 'did-not-land'
  headFoldDetail?: string
  hasHistory: boolean
}): FoldAvailability {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) return { available: false, why: 'compaction-off' }
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

/** THE decision — pure. The prune rung needs a NAMED gap the walk's saving
 *  covers (with the margin); the fold rung needs availability; each rung
 *  runs once per episode; anything else is the typed refusal. */
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

/** The operator's just-sent message rides AROUND the fold, verbatim: when
 *  the view ends in the operator's own turn (a plain user message and any
 *  meta/attachment rows after it, with no assistant reply yet), that tail
 *  is carried and only the history before it folds. A view that ends in a
 *  tool round (the mid-tool overflow) folds whole — the round is paired,
 *  the compaction owner keeps whole rounds, and the summary carries the
 *  ask. `hasHistory` is false when nothing but the carried tail exists. */
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

// ── the sentences (the compact estate's voice) ──────────────────────────────

/** "OpenAI: 135,000 tokens > 128,000" / "estimated 131,000 tokens > 128,000". */
export function overflowWhoClause(signal: OverflowSignal): string {
  const numbers = overflowNumbersClause(signal)
  if (signal.source === 'estimate') return numbers !== undefined ? `estimated ${numbers}` : 'by estimate'
  const who = signal.family === 'unknown' ? 'the provider' : providerDisplayName(signal.family)
  return numbers !== undefined ? `${who}: ${numbers}` : who
}

/** The notice that precedes a recovery rung. */
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

/** The ladder's exhaustion sentence: the stable content key leads (the
 *  transcript lookups and the fold's own retry match on it), then what
 *  happened, then the remedy in the surface's own verbs. */
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
        return 'compaction is disabled (DISABLE_COMPACT), so nothing could fold.'
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

/** The gap the prune rung must cover, in the speaker's own count. */
export function overflowGapFor(signal: OverflowSignal): number | undefined {
  return overflowGapTokens(signal)
}
