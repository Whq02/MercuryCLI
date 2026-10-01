import type { Message } from '../../types/message.js'

export const TOOL_RESULT_CHARACTER_LIMIT = 2000

type ExportTool = { name: string; input: unknown; result: string | null }
type ExportMessage = { role: string; at: string; text: string; tools: ExportTool[] }
export type TranscriptExport = {
  session: { id: string; started: string | null; cwd: string; models: string[] }
  messages: ExportMessage[]
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap(block => {
    if (block?.type === 'text' && typeof block.text === 'string') return [block.text]
    if (block?.type === 'image') return ['[image]']
    if (block?.type === 'document') return ['[document]']
    return []
  }).join('\n')
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  const blocks = Array.isArray(content) ? content : [content]
  return blocks.flatMap(block => {
    if (block?.type === 'thinking' || block?.type === 'redacted_thinking' || block?.type === 'reasoning') return []
    if (typeof block === 'string') return [block]
    const text = contentText([block])
    if (text) return [text]
    const json = JSON.stringify(block, (_key, value) =>
      value?.type === 'thinking' || value?.type === 'redacted_thinking' || value?.type === 'reasoning' ? undefined : value)
    return json === undefined ? [] : [json]
  }).join('\n')
}

export function transcriptExport(messages: Message[], session: { id: string; cwd: string }): TranscriptExport {
  const rows: ExportMessage[] = []
  const models = new Set<string>()
  const calls = new Map<string, ExportTool>()
  const results: Array<{ id: string; row: ExportMessage }> = []
  for (const message of messages) {
    if ('isMeta' in message && message.isMeta) continue
    if (message.type === 'user' || message.type === 'assistant') {
      const content = message.message.content
      const row: ExportMessage = { role: message.type, at: message.timestamp, text: contentText(content), tools: [] }
      if (message.type === 'assistant' && message.message.model) models.add(message.message.model)
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use' || block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
            const tool: ExportTool = { name: block.name, input: block.input ?? null, result: null }
            row.tools.push(tool)
            calls.set(block.id, tool)
          } else if ('tool_use_id' in block && 'content' in block) {
            const result: ExportMessage = { role: 'tool', at: message.timestamp, text: resultText(block.content), tools: [] }
            rows.push(result)
            results.push({ id: block.tool_use_id, row: result })
          }
        }
      }
      if (row.text || row.tools.length) rows.push(row)
    } else if (message.type === 'system' && 'content' in message && typeof message.content === 'string') {
      rows.push({ role: 'system', at: message.timestamp, text: message.content, tools: [] })
    }
  }
  const paired = new Set<ExportMessage>()
  for (const result of results) {
    const call = calls.get(result.id)
    if (call) {
      call.result = result.row.text
      paired.add(result.row)
    }
  }
  return {
    session: { id: session.id, started: messages.find(message => 'timestamp' in message)?.timestamp ?? null, cwd: session.cwd, models: [...models] },
    messages: rows.filter(row => !paired.has(row)),
  }
}

export function truncateExportResults(document: TranscriptExport): TranscriptExport {
  const truncate = (text: string): string => {
    const characters = Array.from(text)
    return characters.length <= TOOL_RESULT_CHARACTER_LIMIT
      ? text
      : characters.slice(0, TOOL_RESULT_CHARACTER_LIMIT).join('') + `… [truncated ${characters.length - TOOL_RESULT_CHARACTER_LIMIT} characters]`
  }
  return {
    session: document.session,
    messages: document.messages.map(message => ({
      ...message,
      text: message.role === 'tool' ? truncate(message.text) : message.text,
      tools: message.tools.map(tool => ({ ...tool, result: tool.result === null ? null : truncate(tool.result) })),
    })),
  }
}

export function transcriptExportText(document: TranscriptExport): string {
  const { session, messages } = document
  const header = [
    `Session: ${session.id}`,
    ...(session.started ? [`Started: ${session.started}`] : []),
    `Directory: ${session.cwd}`,
    ...(session.models.length ? [`Models: ${session.models.join(', ')}`] : []),
  ].join('\n')
  return [header, ...messages.map(message => [
    `${message.role} · ${message.at}`,
    message.text,
    ...message.tools.map(tool => [
      `Tool: ${tool.name}`,
      `Input: ${JSON.stringify(tool.input, null, 2)}`,
      `Result: ${tool.result ?? '[pending]'}`,
    ].join('\n')),
  ].filter(Boolean).join('\n'))].join('\n\n') + '\n'
}
