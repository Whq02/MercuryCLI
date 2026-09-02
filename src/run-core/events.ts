// ============================================================================
//  run-core/events.ts — T8: the run-event vocabulary.
//
//  ONE typed event stream for everything a model-turn run does. The
//  TurnMachine (run-core/turn-machine.ts) emits THESE; query()'s legacy
//  generator shape is a total projection over them (project-legacy.ts), and
//  turn the remaining surfaces (QueryEngine/SDK · print/headless ·
//  REPL · daemon workers) into projections of the same stream
//  (the acceptance: one recorded sequence
//  replayed through all
//  four projections).
//
//  Rules of the vocabulary:
//  • Events are FACTS, not requests — past-tense, emitted after the thing
//    happened (except *_started, which mark entry into an owned phase).
//  • `seq` is monotonic per run and minted ONLY by the core (projections
//    may never renumber). turnId/callId are core-local structured ids
//    (`t2`, `t2.c1`) — deterministic per run with no global uuid draw, so
//    replay fixtures are stable by construction. Durable run identity
//    belongs to the run kernel, not this stream.
//  • An event-vocabulary TURN is one model-request cycle (one loop
//    iteration): recovery retries (max-output-tokens nudges, stop-hook
//    blocking) each open a new turn. The maxTurns budget counts follow-up
//    recursions — a different concept, owned by BudgetGuard.
//  • The Terminal/Continue types from query/transitions.ts ARE the exit
//    vocabulary — this module builds on them, it does not fork them.
//  • Payloads carry REFERENCES to the legacy message objects where a
//    projection needs byte-exact passthrough (prompt-cache identity — the
//    core never clones what flows back to the API; the backfill clone-on-
//    yield rule lives in run-core/model-lane.ts exactly as characterized).
// ============================================================================
import type { Continue, Terminal } from '../query/transitions.js'
import type { ModelCallReference } from './call-reference.js'

// The message payloads are typed REFERENCES to the legacy taxonomy (
// A08 increment: the `unknown` opacity removed — consumers get the real
// union without casts). They remain REFERENCES, never clones: byte-exact
// passthrough for prompt-cache identity is the design (see header). The
// record-native payload vocabulary arrives with the codec verticals.
import type {
  Message,
  RequestStartEvent,
  StreamEvent,
  TombstoneMessage,
  ToolUseSummaryMessage,
} from '../types/message.js'
type OpaqueMessage =
  | Message
  | StreamEvent
  | RequestStartEvent
  | TombstoneMessage
  | ToolUseSummaryMessage

export type RunEvent =
  | {
      kind: 'run_started'
      seq: number
      querySource: string
      agentId: string | undefined
    }
  | { kind: 'turn_started'; seq: number; turnId: string; n: number }
  | {
      kind: 'model_call_started'
      seq: number
      callId: string
      model: string
      /** REQUESTED intent (the floored appState input, pre-resolution) — NOT
       *  the applied/wire effort. Consumers that claim a running effort must
       *  resolve through utils/effort.ts resolveEffortTruth. */
      effort: string | number | undefined
      maxOutputTokensOverride: number | undefined
      /** The FROZEN capability/tool reference for THIS attempt (
       *  law): built at emit, immutable, digest-addressed — the finalized
       *  tool plan for the step (catalogue refresh stays at turn
       *  boundaries; a fallback retry mints a new reference). */
      reference: ModelCallReference
    }
  | {
      /** the provider-boundary admission receipt —
       *  emitted once per attempt, BEFORE model_call_started, from the
       *  capacity governor's acquire (waitedMs 0 = granted immediately;
       *  >0 = the truthful queued/admission wait; reacquired = a fallback
       *  retry revalidating its held permit, never double-counted). */
      kind: 'model_permit'
      seq: number
      callId: string
      lane: string
      waitedMs: number
      reacquired: boolean
    }
  | { kind: 'stream_delta'; seq: number; callId: string; raw: OpaqueMessage }
  | {
      kind: 'assistant_settled'
      seq: number
      callId: string
      message: OpaqueMessage
      /** The message carries a recovery-managed error the surfaces must
       *  NOT see mid-recovery (the WITHHOLDING rule — leaking an
       *  intermediate max_output_tokens error terminates SDK/desktop
       *  consumers). A withheld settlement is never projected; if the
       *  recovery ladder exhausts, `withheld_surfaced` re-presents it. */
      withheld: boolean
    }
  | {
      /** The recovery ladder exhausted — the withheld error message is now
       *  surfaced to consumers, exactly once. */
      kind: 'withheld_surfaced'
      seq: number
      message: OpaqueMessage
    }
  | {
      /** A mid-stream provider fallback orphaned this already-yielded
       *  assistant (partial blocks carry model-bound signatures the retry
       *  cannot replay) — projections must retract it from UI/transcript. */
      kind: 'assistant_retracted'
      seq: number
      message: OpaqueMessage
    }
  | { kind: 'tool_started'; seq: number; toolUseId: string; toolName: string }
  | {
      kind: 'tool_progress'
      seq: number
      toolUseId: string
      message: OpaqueMessage
    }
  | {
      kind: 'tool_settled'
      seq: number
      toolUseId: string
      outcome: 'ok' | 'error' | 'aborted'
      /** True when the core synthesized the result (abort/fallback/catch
       *  pairing — the exactly-once settlement law counts these). */
      synthetic: boolean
      message: OpaqueMessage
    }
  | {
      kind: 'compaction_boundary'
      seq: number
      /** 'auto' — the proactive threshold fold at the loop head; 'overflow'
       *  — the recovery ladder's fold rung: a request overflowed the window
       *  (the provider's typed refusal or the pre-call estimate), the SAME
       *  session folded, and the request is retried once on the fold. */
      trigger: 'auto' | 'overflow'
      messages: OpaqueMessage[]
    }
  | { kind: 'attachment'; seq: number; message: OpaqueMessage }
  | {
      kind: 'followup_drained'
      seq: number
      uuid: string
      source: 'prompt' | 'task-notification'
    }
  | {
      kind: 'interruption'
      seq: number
      phase: 'stream' | 'tools'
      /** signal.reason === 'interrupt' — steer/submit-interrupt paths skip
       *  the interruption message; the projection needs the bit. */
      steer: boolean
      message: OpaqueMessage | null
    }
  | {
      /** A message the stop-hook gate produced mid-run (hook progress,
       *  brief-sentinel nags, blocking re-prompts, the abort-during-hooks
       *  interruption) — streamed through as it happens, never buffered. */
      kind: 'hook_message'
      seq: number
      message: OpaqueMessage
    }
  | {
      kind: 'hook_gate'
      seq: number
      gate: 'stop'
      outcome: 'passed' | 'prevented' | 'blocking'
      /** The blocking re-prompt errors on 'blocking'; empty otherwise. */
      messages: OpaqueMessage[]
    }
  | {
      /** A core-minted surface message that is none of the above: synthetic
       *  API-error surfaces (thrash breaker, blocking preempt, model/image
       *  errors), the fallback warning, the carried tool_use_summary, the
       *  overflow ladder's rung notices and its typed exhaustion refusal
       *  (an overflow error is withheld at settle; the refusal notice IS its
       *  presentation when the ladder exhausts — never the raw sentence).
       *  The message's own `type` field discriminates further. */
      kind: 'notice'
      seq: number
      message: OpaqueMessage
    }
  | { kind: 'turn_settled'; seq: number; transition: Continue }
  | { kind: 'run_terminal'; seq: number; terminal: Terminal }

export type RunEventKind = RunEvent['kind']

/** A RunEvent before the core stamps its sequence number. */
export type UnsequencedRunEvent = {
  [K in RunEventKind]: Omit<Extract<RunEvent, { kind: K }>, 'seq'>
}[RunEventKind]

/** The monotonic sequencer — one per run, owned by the core. */
export function createSequencer(): { next(): number } {
  let seq = 0
  return {
    next: () => ++seq,
  }
}

/** The event mint: stamps `seq` exactly once, at ONE seam. */
export function createEventMint(): (e: UnsequencedRunEvent) => RunEvent {
  const seq = createSequencer()
  return e => ({ ...e, seq: seq.next() }) as RunEvent
}
