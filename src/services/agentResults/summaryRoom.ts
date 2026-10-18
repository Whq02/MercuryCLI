import type { Message } from '../../types/message.js'
import type { QueuedCommand } from '../../types/textInputTypes.js'
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { contextFillView } from '../../utils/contextFill.js'
import { sliceHeadAtGrapheme, sliceTailAtGrapheme } from '../../utils/intl.js'
import { persistToolResult, PERSISTED_OUTPUT_TAG, type ContentReplacementState, type ToolResultReplacementRecord } from '../../utils/toolResultStorage.js'

export const NOTIFICATION_RESULT_CAP_CHARS = 16_000

function shareFor(messages: readonly Message[], model: string, count: number, ceiling: number): number {
  const view = contextFillView(messages, model)
  if (view.windowSource === 'fallback' || view.usedTokens === null || !Number.isFinite(view.usedTokens) || !Number.isFinite(view.window) || view.window <= 0) return ceiling
  return Math.min(ceiling, Math.max(2_000, Math.floor(Math.max(0, view.window - view.usedTokens) * 4 * 0.5 / Math.max(1, count))))
}

function shortened(text: string, cap: number, ref: string, file?: string): string {
  if (text.length <= cap) return text
  const note = `\n[Report shortened to fit this delivery. Full report: ${ref}${file === undefined ? '' : `; full tool result: ${file}`}]\n`
  const room = Math.max(0, cap - note.length)
  const head = sliceHeadAtGrapheme(text, Math.floor(room * 0.8))
  return `${head}${note}${sliceTailAtGrapheme(text, room - head.length)}`
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
}

function completionOf(command: QueuedCommand): NonNullable<QueuedCommand['agentCompletion']> | null {
  const info = command.agentCompletion
  if (command.mode !== 'task-notification' || typeof command.value !== 'string' || typeof info !== 'object' || info === null || !validId(info.agentId)) return null
  if (!Number.isSafeInteger(info.start) || !Number.isSafeInteger(info.end) || info.start < 8 || info.end <= info.start || info.end > command.value.length) return null
  if (command.value.slice(info.start - 8, info.start) !== '<result>' || command.value.slice(info.end, info.end + 9) !== '</result>') return null
  return info
}

export function fitCompletionCommands(commands: QueuedCommand[], parent?: { messages: readonly Message[]; model: string }): QueuedCommand[] {
  if (parent === undefined) return commands
  const count = commands.filter(command => completionOf(command) !== null).length
  if (count === 0) return commands
  const cap = shareFor(parent.messages, parent.model, count, NOTIFICATION_RESULT_CAP_CHARS)
  if (cap === NOTIFICATION_RESULT_CAP_CHARS) return commands
  return commands.map(command => {
    const info = completionOf(command)
    if (info === null || typeof command.value !== 'string') return command
    const result = command.value.slice(info.start, info.end)
    const cut = shortened(result, cap, `mercury://agent/${info.agentId}?child=report`)
    return cut === result ? command : { ...command, value: command.value.slice(0, info.start) + cut + command.value.slice(info.end), agentCompletion: { ...info, end: info.start + cut.length } }
  })
}

export function completionIdentity(data: unknown): { agentId: string; status: 'completed' | 'failed' } | null {
  if (typeof data !== 'object' || data === null) return null
  const result = data as { status?: unknown; agentId?: unknown }
  return (result.status === 'completed' || result.status === 'failed') && validId(result.agentId) ? { agentId: result.agentId, status: result.status } : null
}

export async function fitCompletionResults(messages: Message[], state: ContentReplacementState, model?: string): Promise<ToolResultReplacementRecord[]> {
  if (model === undefined) return []
  const crewCalls = new Set<string>()
  for (const message of messages) {
    if (message.type !== 'assistant') continue
    for (const block of message.message.content) if (block.type === 'tool_use' && block.name === AGENT_TOOL_NAME) crewCalls.add(block.id)
  }
  const candidates: Array<{ message: Message; id: string; agentId: string; content: string | Array<{ type: 'text'; text: string }>; text: string }> = []
  for (const message of messages) {
    if (message.type !== 'user' || !Array.isArray(message.message.content)) continue
    const identity = completionIdentity(message.toolUseResult)
    if (identity === null) continue
    for (const block of message.message.content) {
      if (block.type !== 'tool_result' || !crewCalls.has(block.tool_use_id) || state.seenIds.has(block.tool_use_id) || state.replacements.has(block.tool_use_id)) continue
      const content = block.content
      if (typeof content !== 'string' && (!Array.isArray(content) || content.some(part => part.type !== 'text'))) continue
      const parts = content as string | Array<{ type: 'text'; text: string }>
      const text = typeof parts === 'string' ? parts : parts.map(part => part.text).join('\n')
      candidates.push({ message, id: block.tool_use_id, agentId: identity.agentId, content: parts, text })
    }
  }
  if (candidates.length === 0) return []
  const newMessages = new Set(candidates.map(candidate => candidate.message))
  const cap = shareFor(messages.filter(message => !newMessages.has(message)), model, candidates.length, 100_000)
  const records: ToolResultReplacementRecord[] = []
  for (const candidate of candidates) {
    if (candidate.text.length <= cap) continue
    const priorFile = candidate.text.startsWith(PERSISTED_OUTPUT_TAG) ? /Full output saved to: ([^\n]+)/.exec(candidate.text)?.[1] : undefined
    const persisted = priorFile === undefined ? await persistToolResult(candidate.content, candidate.id) : { filepath: priorFile }
    if ('error' in persisted) continue
    const replacement = shortened(candidate.text, cap, `mercury://agent/${candidate.agentId}?child=report`, persisted.filepath)
    state.replacements.set(candidate.id, replacement)
    records.push({ kind: 'tool-result', toolUseId: candidate.id, replacement })
  }
  return records
}
