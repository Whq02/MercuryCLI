import type { UUID } from 'node:crypto'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { buildConversationChain } from '../../../sessions/transcripts/chain.js'
import { resumeLeafOf } from '../../../sessions/transcripts/sessionListings.js'
import type { TranscriptMessage } from '../../../sessions/transcripts/transcriptEntries.js'
import { SYNTHETIC_MODEL } from '../../../engine/message-shapes/factories.js'
import { NO_RESPONSE_REQUESTED } from '../../../engine/message-shapes/rejectionText.js'
import { extractTag } from '../../../engine/message-shapes/text.js'
import { COMMAND_ARGS_TAG, COMMAND_NAME_TAG, LOCAL_COMMAND_STDERR_TAG, LOCAL_COMMAND_STDOUT_TAG } from '../../../engine/message-shapes/messageTags.js'
import { commandOutputTextOf } from '../../../engine/rows/project.js'
import { toolResultText } from '../childSession.js'
import { toolKindOf, toolLocationsOf, toolOutputContentOf } from './toolWire.js'

export function sessionLineOf(messages: Map<UUID, TranscriptMessage>): TranscriptMessage[] {
  const leaf = resumeLeafOf(messages)
  return leaf === undefined ? [] : buildConversationChain(messages, leaf)
}

function commandAnswerOf(text: string): string | null {
  const head = text.trimStart()
  return head.startsWith(`<${LOCAL_COMMAND_STDOUT_TAG}>`) || head.startsWith(`<${LOCAL_COMMAND_STDERR_TAG}>`) ? commandOutputTextOf(text) : null
}

function commandLineOf(text: string): string | null {
  const name = extractTag(text, COMMAND_NAME_TAG)
  if (name === null) return null
  const args = (extractTag(text, COMMAND_ARGS_TAG) ?? '').trim()
  return args === '' ? name : `${name} ${args}`
}

function textReplayOf(text: string, typed: boolean): SessionUpdate | null {
  const answer = commandAnswerOf(text)
  if (answer !== null) return answer === '' ? null : { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer } }
  const line = commandLineOf(text) ?? (typed ? text : '')
  return line === '' ? null : { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: line } }
}

type ReplayMessage = {
  type?: unknown
  subtype?: unknown
  content?: unknown
  isMeta?: unknown
  isSidechain?: unknown
  isCompactSummary?: unknown
  message?: unknown
}

export function replayUpdatesOf(
  messages: Iterable<ReplayMessage>,
): SessionUpdate[] {
  const updates: SessionUpdate[] = []
  const announced = new Set<string>()
  for (const m of messages) {
    if (m.isMeta === true || m.isSidechain === true || m.isCompactSummary === true) continue
    const message = m.message as { content?: unknown; model?: unknown } | undefined
    const content = message?.content
    if (m.type === 'system') {
      const echoed = m.subtype === 'local_command' && typeof m.content === 'string' ? textReplayOf(m.content, false) : null
      if (echoed !== null) updates.push(echoed)
      continue
    }
    if (m.type === 'user') {
      if (typeof content === 'string') {
        const said = textReplayOf(content, true)
        if (said !== null) updates.push(said)
        continue
      }
      if (!Array.isArray(content)) continue
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === 'text' && typeof block.text === 'string') {
          const said = textReplayOf(block.text, true)
          if (said !== null) updates.push(said)
        } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string' && announced.has(block.tool_use_id)) {
          const text = toolResultText(block.content)
          const output = toolOutputContentOf(text)
          updates.push({
            sessionUpdate: 'tool_call_update',
            toolCallId: block.tool_use_id,
            status: block.is_error === true ? 'failed' : 'completed',
            ...(output !== undefined ? { content: output } : {}),
          })
        }
      }
      continue
    }
    if (m.type === 'assistant') {
      if (!Array.isArray(content)) continue
      const minted = message?.model === SYNTHETIC_MODEL
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text !== '' && !(minted && block.text === NO_RESPONSE_REQUESTED)) {
          updates.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: block.text } })
        } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking !== '') {
          updates.push({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: block.thinking } })
        } else if (block.type === 'tool_use' && typeof block.id === 'string') {
          const name = String(block.name ?? 'tool')
          announced.add(block.id)
          updates.push({
            sessionUpdate: 'tool_call',
            toolCallId: block.id,
            title: name,
            kind: toolKindOf(name),
            status: 'in_progress',
            rawInput: (block.input as Record<string, unknown>) ?? {},
            locations: toolLocationsOf(name, block.input),
          })
        }
      }
    }
  }
  return updates
}
