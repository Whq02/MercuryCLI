import type { Continue, Terminal } from '../query/transitions.js'
import type { ModelCallReference } from './call-reference.js'

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
      effort: string | number | undefined
      maxOutputTokensOverride: number | undefined
      reference: ModelCallReference
    }
  | {
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
      withheld: boolean
    }
  | {
      kind: 'withheld_surfaced'
      seq: number
      message: OpaqueMessage
    }
  | {
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
      synthetic: boolean
      message: OpaqueMessage
    }
  | {
      kind: 'compaction_boundary'
      seq: number
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
      steer: boolean
      message: OpaqueMessage | null
    }
  | {
      kind: 'hook_message'
      seq: number
      message: OpaqueMessage
    }
  | {
      kind: 'hook_gate'
      seq: number
      gate: 'stop'
      outcome: 'passed' | 'prevented' | 'blocking'
      messages: OpaqueMessage[]
    }
  | {
      kind: 'notice'
      seq: number
      message: OpaqueMessage
    }
  | { kind: 'turn_settled'; seq: number; transition: Continue }
  | { kind: 'run_terminal'; seq: number; terminal: Terminal }

export type RunEventKind = RunEvent['kind']

export type UnsequencedRunEvent = {
  [K in RunEventKind]: Omit<Extract<RunEvent, { kind: K }>, 'seq'>
}[RunEventKind]

export function createSequencer(): { next(): number } {
  let seq = 0
  return {
    next: () => ++seq,
  }
}

export function createEventMint(): (e: UnsequencedRunEvent) => RunEvent {
  const seq = createSequencer()
  return e => ({ ...e, seq: seq.next() }) as RunEvent
}
