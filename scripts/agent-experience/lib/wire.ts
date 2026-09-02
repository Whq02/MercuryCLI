
export type Dialect = 'anthropic' | 'responses' | 'chat'

export interface ScriptedCall {
  name: string
  input: Record<string, unknown>
}

export type ScriptedTurn =
  | { calls: ScriptedCall[]; pre?: string }
  | { final: string }

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

let nonce = 0
function callId(prefix: string, i: number): string {
  nonce = (nonce + 1) % 1_000_000
  return `${prefix}_${Date.now().toString(36)}_${nonce.toString(36)}_${i}`
}

export function anthropicSse(turn: ScriptedTurn, model = 'ax-fixture'): string {
  const usage = { input_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }
  const open = `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_ax_${Date.now()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } })}`
  const parts: string[] = [open]
  let index = 0
  const text = 'final' in turn ? turn.final : turn.pre
  if (text !== undefined) {
    parts.push(
      `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })}`,
      `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })}`,
      `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
    )
    index++
  }
  if ('calls' in turn) {
    for (const call of turn.calls) {
      parts.push(
        `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: callId('toolu_ax', index), name: call.name, input: {} } })}`,
        `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } })}`,
        `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
      )
      index++
    }
  }
  const stop = 'calls' in turn ? 'tool_use' : 'end_turn'
  parts.push(
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { input_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  )
  return parts.join('')
}

export function responsesSse(turn: ScriptedTurn): string {
  const parts: string[] = [sse({ type: 'response.created', response: { id: 'resp_ax' } })]
  const text = 'final' in turn ? turn.final : turn.pre
  if (text !== undefined) {
    parts.push(
      sse({ type: 'response.output_text.delta', delta: text }),
      sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }),
    )
  }
  if ('calls' in turn) {
    turn.calls.forEach((call, i) => {
      parts.push(sse({ type: 'response.output_item.done', item: { type: 'function_call', name: call.name, call_id: callId('call_ax', i), arguments: JSON.stringify(call.input) } }))
    })
  }
  parts.push(sse({ type: 'response.completed', response: { id: 'resp_ax', usage: { input_tokens: 8, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } } } }))
  return parts.join('')
}

export function chatSse(turn: ScriptedTurn): string {
  const parts: string[] = []
  const text = 'final' in turn ? turn.final : turn.pre
  if (text !== undefined) {
    parts.push(sse({ id: 'chat_ax', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: text } }] }))
  }
  if ('calls' in turn) {
    parts.push(
      sse({
        id: 'chat_ax',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant', tool_calls: turn.calls.map((call, i) => ({ index: i, id: callId('call_ax', i), type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } })) } }],
      }),
      sse({ id: 'chat_ax', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 8, completion_tokens: 5 } }),
    )
  } else {
    parts.push(sse({ id: 'chat_ax', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2 } }))
  }
  parts.push('data: [DONE]\n\n')
  return parts.join('')
}

export function encode(dialect: Dialect, turn: ScriptedTurn): string {
  if (dialect === 'anthropic') return anthropicSse(turn)
  if (dialect === 'responses') return responsesSse(turn)
  return chatSse(turn)
}


type Body = Record<string, any>

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block: any) => {
      if (typeof block === 'string') return block
      if (block && typeof block.text === 'string') return block.text
      if (block && typeof block.output === 'string') return block.output
      return ''
    })
    .join('\n')
}

export function openerText(body: Body, dialect: Dialect): string {
  if (dialect === 'anthropic') {
    const messages: any[] = Array.isArray(body.messages) ? body.messages : []
    const first = messages.find(m => m && m.role === 'user')
    return first ? textOf(first.content) : ''
  }
  if (dialect === 'responses') {
    const input: any[] = Array.isArray(body.input) ? body.input : typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : []
    const first = input.find(item => item && item.role === 'user')
    return first ? textOf(first.content) : ''
  }
  const messages: any[] = Array.isArray(body.messages) ? body.messages : []
  const first = messages.find(m => m && m.role === 'user')
  return first ? textOf(first.content) : ''
}

export function userTexts(body: Body, dialect: Dialect): string[] {
  const out: string[] = []
  if (dialect === 'responses') {
    for (const item of Array.isArray(body.input) ? body.input : []) {
      if (item && item.role === 'user') {
        const t = textOf(item.content)
        if (t.trim()) out.push(t)
      }
    }
    return out
  }
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!m || m.role !== 'user') continue
    if (dialect === 'anthropic' && Array.isArray(m.content)) {
      const t = m.content
        .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b: any) => b.text)
        .join('\n')
      if (t.trim()) out.push(t)
      continue
    }
    const t = textOf(m.content)
    if (t.trim()) out.push(t)
  }
  return out
}

export function toolResultCount(body: Body, dialect: Dialect): number {
  if (dialect === 'anthropic') {
    let n = 0
    for (const m of Array.isArray(body.messages) ? body.messages : []) {
      if (!m || m.role !== 'user' || !Array.isArray(m.content)) continue
      for (const block of m.content) if (block && block.type === 'tool_result') n++
    }
    return n
  }
  if (dialect === 'responses') {
    let n = 0
    for (const item of Array.isArray(body.input) ? body.input : []) if (item && item.type === 'function_call_output') n++
    return n
  }
  let n = 0
  for (const m of Array.isArray(body.messages) ? body.messages : []) if (m && m.role === 'tool') n++
  return n
}

const REFUSAL_HEAD = /tool calls? (were|was) refused by the harness before execution/i

export function refusedCallCount(body: Body, dialect: Dialect): number {
  let n = 0
  for (const text of userTexts(body, dialect)) {
    if (!REFUSAL_HEAD.test(text)) continue
    const bullets = text.match(/^- call /gm)
    n += bullets ? bullets.length : 1
  }
  return n
}

export function lastToolResultText(body: Body, dialect: Dialect): string {
  if (dialect === 'anthropic') {
    let last = ''
    for (const m of Array.isArray(body.messages) ? body.messages : []) {
      if (!m || m.role !== 'user' || !Array.isArray(m.content)) continue
      for (const block of m.content) if (block && block.type === 'tool_result') last = textOf(block.content)
    }
    return last
  }
  if (dialect === 'responses') {
    let last = ''
    for (const item of Array.isArray(body.input) ? body.input : []) if (item && item.type === 'function_call_output') last = textOf(item.output)
    return last
  }
  let last = ''
  for (const m of Array.isArray(body.messages) ? body.messages : []) if (m && m.role === 'tool') last = textOf(m.content)
  return last
}

export function systemPromptText(body: Body, dialect: Dialect): string {
  if (dialect === 'anthropic') return textOf(body.system)
  if (dialect === 'responses') {
    const parts: string[] = []
    if (typeof body.instructions === 'string') parts.push(body.instructions)
    for (const item of Array.isArray(body.input) ? body.input : []) {
      if (item && (item.role === 'developer' || item.role === 'system')) parts.push(textOf(item.content))
    }
    return parts.join('\n')
  }
  const parts: string[] = []
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (m && (m.role === 'system' || m.role === 'developer')) parts.push(textOf(m.content))
  }
  return parts.join('\n')
}

export interface ToolRoster {
  names: string[]
  schemaChars: number
}

export function toolRoster(body: Body, dialect: Dialect): ToolRoster {
  const tools: any[] = Array.isArray(body.tools) ? body.tools : []
  const names = tools
    .map(t => (dialect === 'chat' ? t?.function?.name : t?.name))
    .filter((n): n is string => typeof n === 'string')
  return { names, schemaChars: tools.length ? JSON.stringify(tools).length : 0 }
}

export function hasForcedToolChoice(body: Body): boolean {
  const tc = body.tool_choice
  if (!tc) return false
  if (typeof tc === 'string') return tc !== 'auto' && tc !== 'none'
  if (typeof tc === 'object') {
    const type = (tc as any).type
    return type === 'tool' || type === 'function' || type === 'any' || type === 'required'
  }
  return false
}

export function assistantTurnCount(body: Body, dialect: Dialect): number {
  if (dialect === 'responses') {
    let n = 0
    for (const item of Array.isArray(body.input) ? body.input : []) if (item && item.role === 'assistant') n++
    return n
  }
  let n = 0
  for (const m of Array.isArray(body.messages) ? body.messages : []) if (m && m.role === 'assistant') n++
  return n
}
