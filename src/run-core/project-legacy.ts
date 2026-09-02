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

export function legacyYieldsOf(event: RunEvent): LegacyQueryYield[] {
  switch (event.kind) {
    case 'turn_started':
      return [{ type: 'stream_request_start' }]
    case 'stream_delta':
      return [event.raw as LegacyQueryYield]
    case 'assistant_settled':
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
    throw new Error('run-core: event stream ended without run_terminal')
  }
  return terminal
}
