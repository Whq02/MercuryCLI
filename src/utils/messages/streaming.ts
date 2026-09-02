
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

export type StreamingToolUseUpdateOpts = {
  silent?: boolean
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
    if (message.type === 'tombstone') {
      onTombstone?.(message.message)
      return
    }
    if (message.type === 'tool_use_summary') {
      return
    }
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
    onStreamingText?.(() => null)
    onMessage(message)
    return
  }

  if (message.type === 'stream_request_start') {
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
          pulseMark('first_thinking_event')
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
          fluxCount('text-delta')
          fluxMark('delta:text', deltaText.length)
          {
            const g = getActivePulseTrace()?.generation ?? 0
            pulseMark('first_text_delta')
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
          fluxCount('tool-delta')
          notePulseStreamActivity(
            getActivePulseTrace()?.generation ?? 0,
            'tool-input',
          )
          onUpdateLength(delta)
          onStreamingToolUses(
            current => {
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
          return
        default:
          return
      }
    case 'content_block_stop':
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
