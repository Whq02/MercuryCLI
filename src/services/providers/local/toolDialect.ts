import type { ZaiContentPart, ZaiTool, ZaiWireMessage } from '../zai/zaiClient.js'

export const TOOL_DIALECT_WORDS = [
  'The tools you can use are declared below as JSON, one per line: the name, what it does, and the JSON Schema of its arguments.',
  'To call a tool, end your reply with one tool_call block per call, each holding one JSON object with the tool\'s name and its arguments, and write nothing after the last block:',
  '<tool_call>',
  '{"name": "ToolName", "arguments": {"argument": "value"}}',
  '</tool_call>',
  'The result of each call comes back in the next message as a tool_result block carrying the call\'s id and the tool\'s name. A reply with no tool_call block is your answer.',
].join('\n')

export function toolDialectSystemText(systemText: string, tools: readonly ZaiTool[]): string {
  return `${systemText}\n\n${TOOL_DIALECT_WORDS}\n<tools>\n${tools.map(tool => JSON.stringify(tool)).join('\n')}\n</tools>`
}

export function toolDialectCall(name: string, argumentsJson: string): string {
  let args: unknown = {}
  try {
    args = JSON.parse(argumentsJson === '' ? '{}' : argumentsJson)
  } catch {
    args = argumentsJson
  }
  return `<tool_call>\n${JSON.stringify({ name, arguments: args })}\n</tool_call>`
}

export function toolDialectResult(callId: string, name: string | undefined, text: string): string {
  return `<tool_result id="${callId}"${name !== undefined ? ` name="${name}"` : ''}>\n${text}\n</tool_result>`
}

function textOf(content: string | null | ZaiContentPart[] | undefined): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => (part.type === 'text' ? part.text : '')).join('')
}

export function renderToolDialectHistory(messages: readonly ZaiWireMessage[]): ZaiWireMessage[] {
  const namesByCallId = new Map<string, string>()
  for (const message of messages) {
    if ('tools' in message) continue
    for (const call of message.tool_calls ?? []) namesByCallId.set(call.id, call.function.name)
  }
  const out: ZaiWireMessage[] = []
  let pending: string[] = []
  const flush = (into?: { role: 'user'; content: string | null | ZaiContentPart[] }): void => {
    if (pending.length === 0) {
      if (into !== undefined) out.push(into)
      return
    }
    const results = pending.join('\n\n')
    pending = []
    if (into === undefined) {
      out.push({ role: 'user', content: results })
      return
    }
    if (Array.isArray(into.content)) {
      out.push({ role: 'user', content: [{ type: 'text', text: `${results}\n\n` }, ...into.content] })
      return
    }
    const words = textOf(into.content)
    out.push({ role: 'user', content: words === '' ? results : `${results}\n\n${words}` })
  }
  for (const message of messages) {
    if ('tools' in message) {
      pending.push(`Additional tools declared for this conversation from this point on, in the same format as your tool list; call them exactly like the tools declared there.\n<tools>\n${message.tools.map(tool => JSON.stringify(tool)).join('\n')}\n</tools>`)
      continue
    }
    if (message.role === 'tool') {
      const callId = message.tool_call_id ?? ''
      pending.push(callId === '' ? textOf(message.content) : toolDialectResult(callId, namesByCallId.get(callId), textOf(message.content)))
      continue
    }
    if (message.role === 'user') {
      flush({ role: 'user', content: message.content })
      continue
    }
    flush()
    if (message.role === 'assistant' && message.tool_calls !== undefined && message.tool_calls.length > 0) {
      const calls = message.tool_calls.map(call => toolDialectCall(call.function.name, call.function.arguments)).join('\n')
      const words = textOf(message.content)
      out.push({
        role: 'assistant',
        content: words === '' ? calls : `${words}\n\n${calls}`,
        ...(message.reasoning_content !== undefined ? { reasoning_content: message.reasoning_content } : {}),
      })
      continue
    }
    out.push(message)
  }
  flush()
  return out
}
