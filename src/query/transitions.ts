/* ============================================================================
   query/transitions — the closed type vocabulary of the agentic query loop's
   two exit shapes. SINGLE SOURCE OF TRUTH for what the loop can return and why
   it continues; query.ts imports these as `type`-only (no runtime surface).

   - `Terminal` is the value `query()` resolves to: every TERMINAL `return {
     reason: ... }` in queryLoop produces one of these. Exhaustive — adding a new
     terminal return site means adding its reason here.
   - `Continue` is `State.transition`: why the PREVIOUS iteration looped instead
     of returning. Undefined on the first iteration. Lets tests assert a recovery
     path fired (e.g. reactive_compact_retry) without inspecting message bodies,
     and lets the loop gate on the prior transition (see the collapse_drain_retry
     guard at the prompt-too-long recovery site).

   Both unions are discriminated on `reason`; a couple of variants carry a small
   numeric payload (the recovery attempt counter, the drained-collapse count, the
   max-turns count) so a consumer never has to re-derive it from message state.
   ============================================================================ */

/**
 * Why the query loop STOPPED — the value `query()` resolves to. One per terminal
 * `return { reason: ... }` in queryLoop.
 *
 * - `completed`: the model produced a final response (no tool_use) and stop hooks
 *   allowed it, OR a non-recoverable API error surfaced as the last assistant
 *   message, OR the token budget chose to stop.
 * - `model_error`: queryModelWithStreaming threw (carries the thrown `error`).
 * - `image_error`: an ImageSizeError/ImageResizeError, or an unrecoverable
 *   withheld media-size rejection.
 * - `prompt_too_long`: a PROVIDER-reported context overflow (the typed
 *   OverflowSignal every family's runtime stamps) that the recovery ladder
 *   could not resolve — the fold ran and the retry overflowed again, or no
 *   fold was available; the typed refusal notice names which.
 * - `blocking_limit`: the pre-call estimate crossed the hard blocking limit
 *   and the ladder's prune rung could not cover it (the loop head's own
 *   auto-compaction is the fold rung on this side; with auto-compact OFF
 *   the refusal names /compact).
 * - `rapid_refill_breaker`: the autocompact thrash (rapid-refill) circuit breaker
 *   tripped — context kept refilling to the limit within a few turns of a compact.
 * - `max_turns`: the maxTurns cap was reached (carries the `turnCount` that hit it).
 * - `aborted_streaming`: the abort signal fired during model streaming.
 * - `aborted_tools`: the abort signal fired during tool execution.
 * - `stop_hook_prevented`: a stop hook explicitly prevented continuation.
 * - `hook_stopped`: a tool hook emitted hook_stopped_continuation.
 */
export type Terminal =
  | { reason: 'completed' }
  | { reason: 'model_error'; error: unknown }
  | { reason: 'image_error' }
  | { reason: 'prompt_too_long' }
  | { reason: 'blocking_limit' }
  | { reason: 'rapid_refill_breaker' }
  | { reason: 'max_turns'; turnCount: number }
  | {
      /** the cycle guard settled a stagnant turn with a
       *  handoff instead of another provider call (S1-S3 at the re-entry
       *  seam — one replan directive was already spent or the folded phase
       *  reached handoff-required). */
      reason: 'cycle_handoff'
      cause: string
    }
  | {
      /** the repetition breaker (services/tools/identicalFailureGuard.ts)
       *  ended the turn: the model ran the identical call past its nudge
       *  until the streak crossed its stop bound — no further provider call. */
      reason: 'repetition_breaker'
      cause: string
    }
  | { reason: 'aborted_streaming' }
  | { reason: 'aborted_tools' }
  | { reason: 'stop_hook_prevented' }
  | { reason: 'hook_stopped' }

/**
 * Why the PREVIOUS loop iteration CONTINUED instead of returning — stored on
 * `State.transition` (undefined on the first iteration). One per `transition: {
 * reason: ... }` written at a continue site in queryLoop.
 *
 * - `next_turn`: the ordinary case — the model called tools, results were
 *   appended, and the loop recurses for the follow-up turn.
 * - `collapse_drain_retry`: a withheld 413 drained staged context-collapses
 *   (carries how many were `committed`); the loop retries with the smaller view.
 * - `reactive_compact_retry`: a withheld 413/media error triggered reactive
 *   compact; the loop retries on the post-compact messages.
 * - `max_output_tokens_escalate`: a max_output_tokens hit at the capped default
 *   retried the SAME request once at the escalated cap.
 * - `max_output_tokens_recovery`: a max_output_tokens hit injected a resume
 *   nudge and recursed (carries the recovery `attempt` number).
 * - `stop_hook_blocking`: a stop hook returned blocking errors; they were
 *   appended and the loop recurses with stopHookActive set.
 * - `token_budget_continuation`: the token-budget tracker chose to keep going and
 *   appended a continuation nudge.
 * - `stream_fault_recovery`: a provider stream faulted AFTER partial content
 *   settled (the continuable class — OpenAI/Z.AI); ONE bounded continuation
 *   nudge was injected instead of dying with the error as the session tail
 * - `tool_call_refusal_recovery`: every tool call of the turn was refused at
 *   the transport boundary (unknown tool / arguments outside the tool's
 *   schema — the non-Anthropic families' gate); the typed correction was
 *   injected as the next user turn so the model re-issues the call (carries
 *   the bounded `attempt` number).
 * - `overflow_recovery`: the request overflowed the window (a provider's
 *   typed refusal, or the pre-call estimate) and the ladder took a rung —
 *   `prune` (superseded tool results cleared, the request retried) or
 *   `fold` (the loop head folds the same session, then retries). Each rung
 *   at most once per episode; the exhaustion is a typed terminal.
 *
 */
export type Continue =
  | { reason: 'next_turn' }
  | { reason: 'collapse_drain_retry'; committed: number }
  | { reason: 'reactive_compact_retry' }
  | { reason: 'max_output_tokens_escalate' }
  | { reason: 'max_output_tokens_recovery'; attempt: number }
  | { reason: 'stop_hook_blocking' }
  | { reason: 'token_budget_continuation' }
  | { reason: 'stream_fault_recovery'; attempt: number }
  | { reason: 'tool_call_refusal_recovery'; attempt: number }
  | { reason: 'checkpoint_settle_guard' }
  | { reason: 'overflow_recovery'; rung: 'prune' | 'fold'; source: 'provider' | 'estimate' }
