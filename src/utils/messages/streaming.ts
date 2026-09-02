// Stream-event fan-out — routes SSE messages/deltas into the REPL's
// streaming-state callbacks (spinner mode, live text, tool-input assembly,
// thinking capture, tombstones).; the original lived inline in utils/messages.ts.

import type { ToolUseBlock } from '../../types/wire.js'
import { fluxCount, fluxMark } from '../flux/fluxProbe.js'
import {
  armPulseTerminalWriteMark,
  getActivePulseTrace,
  notePulseStreamActivity,
  pulseMark,
  setPulsePhase,
} from '../pulse/index.js'
import type { SpinnerMode } from '../../components/Spinner.js'
import type {
  Message,
  RequestStartEvent,
  StreamEvent,
  TombstoneMessage,
  ToolUseSummaryMessage,
} from '../../types/message.js'

export type StreamingToolUse = {
  index: number
  contentBlock: ToolUseBlock
  unparsedToolInput: string
}

export type StreamingThinking = {
  thinking: string
  isStreaming: boolean
  streamingEndedAt?: number
}

/**
 * True for stream frames that must be DROPPED once the owning turn's
 * controller has aborted: late `stream_event` / `stream_request_start`
 * frames still draining out of the generator would repopulate visible
 * streaming state (ghost spinner mode, resurrected streaming text/tool
 * input) after the user already cancelled. Non-stream settlement messages
 * — the interrupt marker (user), final assistant content, attachments —
 * always flow through.
 */
export function isDroppedLateStreamFrame(
  message: { type: string },
  aborted: boolean,
): boolean {
  return (
    aborted &&
    (message.type === 'stream_event' ||
      message.type === 'stream_request_start')
  )
}

/**
 * Handle one message from the model stream: deltas update the live counters/
 * text, completed messages append, tombstones remove their target.
 */
/** Per-update routing hints for the streaming-tool-use sink. */
export type StreamingToolUseUpdateOpts = {
  /**
   * Accumulate WITHOUT scheduling a React commit (input_json_delta storms —
   * partial tool input renders nothing, so per-delta commits are pure waste).
   */
  silent?: boolean
  /** Commit any silent accumulation now (content_block_stop). */
  flushSilent?: boolean
}

export function handleMessageFromStream(
  message:
    | Message
    | TombstoneMessage
    | StreamEvent
    | RequestStartEvent
    | ToolUseSummaryMessage,
  onMessage: (message: Message) => void,
  onUpdateLength: (newContent: string) => void,
  onSetStreamMode: (mode: SpinnerMode) => void,
  onStreamingToolUses: (
    f: (streamingToolUse: StreamingToolUse[]) => StreamingToolUse[],
    opts?: StreamingToolUseUpdateOpts,
  ) => void,
  onTombstone?: (message: Message) => void,
  onStreamingThinking?: (
    f: (current: StreamingThinking | null) => StreamingThinking | null,
  ) => void,
  onApiMetrics?: (metrics: { ttftMs: number }) => void,
  onStreamingText?: (f: (current: string | null) => string | null) => void,
): void {
  if (
    message.type !== 'stream_event' &&
    message.type !== 'stream_request_start'
  ) {
    // Tombstones remove their targeted message instead of appending.
    if (message.type === 'tombstone') {
      onTombstone?.(message.message)
      return
    }
    // Tool-use summaries are SDK-only.
    if (message.type === 'tool_use_summary') {
      return
    }
    // Capture completed thinking blocks for live transcript display.
    if (message.type === 'assistant') {
      const thinkingBlock = message.message.content.find(
        block => block.type === 'thinking',
      )
      if (thinkingBlock && thinkingBlock.type === 'thinking') {
        onStreamingThinking?.(() => ({
          thinking: thinkingBlock.thinking,
          isStreaming: false,
          streamingEndedAt: Date.now(),
        }))
      }
    }
    // Clear streaming text in the SAME call as the append. The commit
    // boundary between them is not this fan-out's to force: the settle's
    // atomicity on screen is the tail store's settle ghost (the tail keeps
    // painting the retired text in place until the rendered transcript
    // shows the reply). A flushSync pairing here was measured to multiply
    // retained row subtrees 6.4× over thirty turns (the paint-hardening
    // wave's bisect) and was removed.
    onStreamingText?.(() => null)
    onMessage(message)
    return
  }

  if (message.type === 'stream_request_start') {
    //  semantics note: this event fires at query-loop entry —
    // BEFORE compaction/schema/normalization/client setup — so it does NOT
    // mean "request in flight". It survives byte-compatible for the legacy
    // SpinnerMode surface; the honest phases (preparing → dispatching →
    // waiting) ride the pulse phase machine from the real seams
    // (turn-machine model assembly · streamCore api_request_sent).
    onSetStreamMode('requesting')
    return
  }

  if (message.event.type === 'message_start') {
    if (message.ttftMs != null) {
      onApiMetrics?.({ ttftMs: message.ttftMs })
    }
  }

  if (message.event.type === 'message_stop') {
    onSetStreamMode('tool-use')
    // Identity when already empty — a turn that streamed no tool input must
    // not buy an empty→empty reset commit.
    onStreamingToolUses(current => (current.length === 0 ? current : []))
    return
  }

  switch (message.event.type) {
    case 'content_block_start':
      onStreamingText?.(() => null)

      switch (message.event.content_block.type) {
        case 'thinking':
        case 'redacted_thinking': {
          const g = getActivePulseTrace()?.generation ?? 0
          pulseMark('first_thinking_event') // latched: first stamp wins
          notePulseStreamActivity(g, 'thinking')
          setPulsePhase(g, 'thinking')
          onSetStreamMode('thinking')
          return
        }
        case 'text': {
          const g = getActivePulseTrace()?.generation ?? 0
          notePulseStreamActivity(g, 'text')
          setPulsePhase(g, 'responding')
          onSetStreamMode('responding')
          return
        }
        case 'tool_use': {
          const g = getActivePulseTrace()?.generation ?? 0
          notePulseStreamActivity(g, 'tool-input')
          setPulsePhase(g, 'responding')
          onSetStreamMode('tool-input')
          const contentBlock = message.event.content_block
          const index = message.event.index
          onStreamingToolUses(current => [
            ...current,
            { index, contentBlock, unparsedToolInput: '' },
          ])
          return
        }
        case 'server_tool_use':
        case 'web_search_tool_result':
        case 'code_execution_tool_result':
        case 'mcp_tool_use':
        case 'mcp_tool_result':
        case 'container_upload':
        case 'web_fetch_tool_result':
        case 'bash_code_execution_tool_result':
        case 'text_editor_code_execution_tool_result':
        case 'tool_search_tool_result':
        case 'compaction':
          onSetStreamMode('tool-input')
          return
      }
      return
    case 'content_block_delta':
      switch (message.event.delta.type) {
        case 'text_delta': {
          const deltaText = message.event.delta.text
          fluxCount('text-delta') // MERCURY_FLUX_PROBE only; off ⇒ no-op
          fluxMark('delta:text', deltaText.length) // ring-stamped arrival (probe-gated)
          {
            const g = getActivePulseTrace()?.generation ?? 0
            pulseMark('first_text_delta') // latched: first stamp wins
            armPulseTerminalWriteMark('first_text_terminal_write', g)
            notePulseStreamActivity(g, 'text')
          }
          onUpdateLength(deltaText)
          onStreamingText?.(text => (text ?? '') + deltaText)
          return
        }
        case 'input_json_delta': {
          const delta = message.event.delta.partial_json
          const index = message.event.index
          fluxCount('tool-delta') // MERCURY_FLUX_PROBE only; off ⇒ no-op
          notePulseStreamActivity(
            getActivePulseTrace()?.generation ?? 0,
            'tool-input',
          )
          onUpdateLength(delta)
          // SILENT accumulation: partial tool input renders nothing (no
          // consumer reads unparsedToolInput mid-block), so a 100-delta
          // Write-body storm schedules ZERO React commits. The accumulated
          // value stays ref-fresh; content_block_stop below commits it.
          onStreamingToolUses(
            current => {
              // Replace IN PLACE: the old filter+append
              // REORDERED the array on every delta — under the frame-cadence
              // batcher a reorder could paint a tool result above its own
              // tool_use row. Stable order also lets React key-reconcile rows
              // instead of remounting them.
              const at = current.findIndex(t => t.index === index)
              if (at < 0) return current
              const next = current.slice()
              next[at] = {
                ...next[at]!,
                unparsedToolInput: next[at]!.unparsedToolInput + delta,
              }
              return next
            },
            { silent: true },
          )
          return
        }
        case 'thinking_delta':
          notePulseStreamActivity(
            getActivePulseTrace()?.generation ?? 0,
            'thinking',
          )
          onUpdateLength(message.event.delta.thinking)
          return
        case 'signature_delta':
          // Signatures are authentication strings, not model output —
          // excluding them keeps OTPS and the token counter honest.
          return
        default:
          return
      }
    case 'content_block_stop':
      // The block's accumulated tool input (if any) is complete — commit the
      // silent accumulation so the final input lands before its tool result
      // (which arrives on a later stream message). A no-op for text blocks.
      onStreamingToolUses(current => current, { flushSilent: true })
      return
    case 'message_delta':
      onSetStreamMode('responding')
      return
    default:
      onSetStreamMode('responding')
      return
  }
}
