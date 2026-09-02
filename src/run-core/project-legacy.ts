// ============================================================================
//  run-core/project-legacy.ts — T8: the legacy projection.
//
//  query()'s public generator contract, as a TOTAL function over the
//  RunEvent stream. Every event maps to zero-or-more legacy yields — no
//  event is unhandled, no legacy yield exists that some event doesn't
//  carry. The 144-check runloop contract (and the recorded yield corpus
//  inside it) passes byte-identically across the queryLoop → TurnMachine
//  swap because this mapping preserves both ORDER (events are emitted at
//  exactly the old yield points) and IDENTITY (payloads are references to
//  the same message objects — reference-equality laws L3/L6 hold).
//
//  `legacyYieldsOf` is the pure per-event mapping; the generator wraps it.
//  QueryEngine consumes the SAME function over queryEvents so the
//  SDK envelope and the legacy generator can never diverge on what a
//  RunEvent "means" in message terms.
//
//  Silent kinds (run_started · model_call_started · tool_started ·
//  followup_drained · hook_gate · turn_settled) are the vocabulary's net
//  gain: consumers project them into typed turn state instead of
//  re-deriving it from message shapes.
// ============================================================================
import type {
  AssistantMessage,
  Message,
  RequestStartEvent,
  StreamEvent,
  TombstoneMessage,
  ToolUseSummaryMessage,
} from '../types/message.js'
import type { Terminal } from '../query/transitions.js'
import type { RunEvent } from './events.js'

export type LegacyQueryYield =
  | StreamEvent
  | RequestStartEvent
  | Message
  | TombstoneMessage
  | ToolUseSummaryMessage

/** The pure per-event mapping: what this RunEvent means as legacy query()
 *  yields, in order. Total over the vocabulary; identity-preserving
 *  (payloads pass by reference — never cloned, never re-wrapped except
 *  the tombstone envelope the legacy shape requires). */
export function legacyYieldsOf(event: RunEvent): LegacyQueryYield[] {
  switch (event.kind) {
    case 'turn_started':
      return [{ type: 'stream_request_start' }]
    case 'stream_delta':
      return [event.raw as LegacyQueryYield]
    case 'assistant_settled':
      // The withholding rule: a recovery-managed error never reaches a
      // consumer mid-recovery; withheld_surfaced re-presents it iff the
      // ladder exhausts.
      return event.withheld ? [] : [event.message as LegacyQueryYield]
    case 'assistant_retracted':
      return [
        {
          type: 'tombstone',
          message: event.message as AssistantMessage,
        },
      ]
    case 'compaction_boundary':
      return event.messages as LegacyQueryYield[]
    case 'interruption':
      return event.message === null ? [] : [event.message as LegacyQueryYield]
    case 'withheld_surfaced':
    case 'tool_progress':
    case 'tool_settled':
    case 'attachment':
    case 'hook_message':
    case 'notice':
      return [event.message as LegacyQueryYield]
    case 'run_terminal':
    case 'run_started':
    case 'model_call_started':
    // The admission receipt is machine truth for capacity
    // projections — the legacy query() surface has no shape for it.
    case 'model_permit':
    case 'tool_started':
    case 'followup_drained':
    case 'hook_gate':
    case 'turn_settled':
      return []
  }
}

export async function* projectLegacyYields(
  events: AsyncGenerator<RunEvent, Terminal>,
): AsyncGenerator<LegacyQueryYield, Terminal> {
  let terminal: Terminal | undefined
  for await (const event of events) {
    if (event.kind === 'run_terminal') {
      terminal = event.terminal
      continue
    }
    for (const legacy of legacyYieldsOf(event)) {
      yield legacy
    }
  }
  if (!terminal) {
    // Machine invariant: every terminal return emits run_terminal first.
    throw new Error('run-core: event stream ended without run_terminal')
  }
  return terminal
}
