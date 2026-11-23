
export type Terminal =
  | { reason: 'aborted_streaming' }
  | { reason: 'aborted_tools' }
  | { reason: 'blocking_limit' }
  | { reason: 'completed' }
  | { reason: 'hook_stopped' }
  | { reason: 'image_error' }
  | { reason: 'loop_stopped'; cycle: string[] }
  | { reason: 'max_turns'; turnCount: number }
  | { reason: 'model_error'; error: unknown }
  | { reason: 'prompt_too_long' }
  | { reason: 'rapid_refill_breaker' }
  | { reason: 'stop_hook_prevented' }
  | { reason: 'tool_calls_refused'; tools: string[]; corrections: number }

export type Continue =
  | { reason: 'announced_step_nudge'; attempt: number }
  | { reason: 'chant_recovery'; attempt: number }
  | { reason: 'checkpoint_settle_guard' }
  | { reason: 'cut_tool_call_recovery'; attempt: number; outputTokens: number }
  | { reason: 'empty_reply_retry'; attempt: number }
  | { reason: 'max_output_tokens_recovery'; attempt: number }
  | { reason: 'next_turn' }
  | { reason: 'overflow_recovery'; rung: 'prune' | 'fold'; source: 'provider' | 'estimate' }
  | { reason: 'pause_turn_continuation'; attempt: number }
  | { reason: 'queued_message'; count: number }
  | { reason: 'reasoning_only_recovery'; attempt: number }
  | { reason: 'stop_hook_blocking' }
  | { reason: 'stream_fault_recovery'; attempt: number }
  | { reason: 'tool_call_refusal_recovery'; attempt: number }
