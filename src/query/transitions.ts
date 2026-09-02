


export type Terminal =
  | { reason: 'completed' }
  | { reason: 'model_error'; error: unknown }
  | { reason: 'image_error' }
  | { reason: 'prompt_too_long' }
  | { reason: 'blocking_limit' }
  | { reason: 'rapid_refill_breaker' }
  | { reason: 'max_turns'; turnCount: number }
  | {
      reason: 'cycle_handoff'
      cause: string
    }
  | {
      reason: 'repetition_breaker'
      cause: string
    }
  | { reason: 'aborted_streaming' }
  | { reason: 'aborted_tools' }
  | { reason: 'stop_hook_prevented' }
  | { reason: 'hook_stopped' }

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
