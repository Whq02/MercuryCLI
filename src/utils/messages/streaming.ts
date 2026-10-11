import type { ToolUseBlock } from '../../types/wire.js'
import type { SpinnerMode } from '../../components/Spinner.js'
import type { Message, RequestStartEvent, StreamEvent, TombstoneMessage, ToolUseSummaryMessage } from '../../types/message.js'
import { fluxCount, fluxMark } from '../flux/fluxProbe.js'

export type StreamingThinking = { thinking: string; isStreaming: boolean; streamingEndedAt?: number }
export type StreamingToolUseUpdateOpts = { silent?: boolean; flushSilent?: boolean }
export type StreamingToolUse = { index: number; contentBlock: ToolUseBlock; unparsedToolInput: string }
type UpdateTools = (f: (current: StreamingToolUse[]) => StreamingToolUse[], opts?: StreamingToolUseUpdateOpts) => void
type UpdateText = (f: (current: string | null) => string | null) => void
type UpdateThinking = (f: (current: StreamingThinking | null) => StreamingThinking | null) => void

const openingModes: Readonly<Record<string, SpinnerMode>> = {
  thinking: 'thinking', redacted_thinking: 'thinking', text: 'responding',
  tool_use: 'tool-input', server_tool_use: 'tool-input', web_search_tool_result: 'tool-input',
  code_execution_tool_result: 'tool-input', mcp_tool_use: 'tool-input', mcp_tool_result: 'tool-input',
  container_upload: 'tool-input', web_fetch_tool_result: 'tool-input', bash_code_execution_tool_result: 'tool-input',
  text_editor_code_execution_tool_result: 'tool-input', tool_search_tool_result: 'tool-input', compaction: 'tool-input',
}

const clearText = (): null => null
const keepTools = (current: StreamingToolUse[]): StreamingToolUse[] => current
const clearTools = (current: StreamingToolUse[]): StreamingToolUse[] => current.length ? [] : current

function appendInput(index: number, delta: string): (current: StreamingToolUse[]) => StreamingToolUse[] {
  return current => {
    const at = current.findIndex(t => t.index === index)
    if (at < 0) return current
    const next = current.slice()
    const entry = current[at]!
    next[at] = { ...entry, unparsedToolInput: entry.unparsedToolInput + delta }
    return next
  }
}

function publishDelta(event: Extract<StreamEvent['event'], { type: 'content_block_delta' }>,
  length: (text: string) => void, tools: UpdateTools, text?: UpdateText): void {
  const delta = event.delta
  if (delta.type === 'thinking_delta') {
    length(delta.thinking)
    return
  }
  if (delta.type === 'text_delta') {
    const chunk = delta.text
    fluxCount('text-delta')
    fluxMark('delta:text', chunk.length)
    length(chunk)
    text?.(before => (before ?? '') + chunk)
    return
  }
  if (delta.type === 'input_json_delta') {
    const chunk = delta.partial_json
    const index = event.index
    fluxCount('tool-delta')
    length(chunk)
    tools(appendInput(index, chunk), { silent: true })
  }
}

function publishSettled(message: Message, append: (message: Message) => void, text?: UpdateText, thinking?: UpdateThinking): void {
  if (message.type === 'assistant') {
    const block = message.message.content.find(item => item.type === 'thinking')
    if (block?.type === 'thinking') thinking?.(() => ({ thinking: block.thinking, isStreaming: false, streamingEndedAt: Date.now() }))
  }
  text?.(clearText)
  append(message)
}

export function isDroppedLateStreamFrame(message: { type: string }, aborted: boolean): boolean {
  if (!aborted) return false
  return message.type === 'stream_event' || message.type === 'stream_request_start'
}

export function handleMessageFromStream(
  message: Message | TombstoneMessage | StreamEvent | RequestStartEvent | ToolUseSummaryMessage,
  onMessage: (message: Message) => void,
  onUpdateLength: (newContent: string) => void,
  onSetStreamMode: (mode: SpinnerMode) => void,
  onStreamingToolUses: UpdateTools,
  onTombstone?: (message: Message) => void,
  onStreamingThinking?: UpdateThinking,
  onApiMetrics?: (metrics: { ttftMs: number }) => void,
  onStreamingText?: UpdateText,
): void {
  switch (message.type) {
    case 'tool_use_summary': return
    case 'tombstone': onTombstone?.(message.message); return
    case 'stream_request_start': onSetStreamMode('requesting'); return
    case 'stream_event': break
    default: publishSettled(message, onMessage, onStreamingText, onStreamingThinking); return
  }
  const event = message.event
  switch (event.type) {
    case 'content_block_delta': publishDelta(event, onUpdateLength, onStreamingToolUses, onStreamingText); return
    case 'content_block_stop': onStreamingToolUses(keepTools, { flushSilent: true }); return
    case 'content_block_start': {
      onStreamingText?.(clearText)
      const block = event.content_block
      const mode = Object.hasOwn(openingModes, block.type) ? openingModes[block.type] : undefined
      if (mode) onSetStreamMode(mode)
      if (block.type === 'tool_use') {
        const index = event.index
        onStreamingToolUses(current => [...current, { index, contentBlock: block, unparsedToolInput: '' }])
      }
      return
    }
    case 'message_stop': onSetStreamMode('tool-use'); onStreamingToolUses(clearTools); return
    case 'message_start': if (message.ttftMs != null) onApiMetrics?.({ ttftMs: message.ttftMs })
  }
  onSetStreamMode('responding')
}
