import { appendFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

type FixtureLane = 'anthropic-seat' | 'openai-seat' | 'zai-seat' | 'openrouter-seat' | 'other'
interface FixtureHit {
  lane: FixtureLane
  path: string
  model: string
  body: Record<string, unknown>
}

export const CMA_STEER_TEXT = 'steer-note: adjust the alpha seat heading'

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

type Emit =
  | { tool: { name: string; input: unknown } }
  | { tools: Array<{ name: string; input: unknown }> }
  | { final: string }
  | { pre: string; tool: { name: string; input: unknown } }

function anthropicSse(kind: Emit): string {
  const open = `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`
  const parts: string[] = [open]
  let index = 0
  if ('pre' in kind) {
    parts.push(
      `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })}`,
      `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: kind.pre } })}`,
      `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
    )
    index++
  }
  const toolList = 'tools' in kind ? kind.tools : 'tool' in kind ? [kind.tool] : []
  if (toolList.length > 0) {
    for (const tool of toolList) {
      parts.push(
        `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_fx_${Date.now() % 100000}_${index}`, name: tool.name, input: {} } })}`,
        `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } })}`,
        `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
      )
      index++
    }
    parts.push(
      `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { input_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 } })}`,
      `event: message_stop\n${sse({ type: 'message_stop' })}`,
    )
    return parts.join('')
  }
  parts.push(
    `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: (kind as { final: string }).final } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  )
  return parts.join('')
}

function responsesSse(kind: Emit): string {
  const toolList = 'tools' in kind ? kind.tools : 'tool' in kind ? [kind.tool] : []
  if (toolList.length > 0) {
    return [
      sse({ type: 'response.created', response: { id: 'resp_fx' } }),
      ...toolList.map((tool, i) =>
        sse({ type: 'response.output_item.done', item: { type: 'function_call', name: tool.name, call_id: `call_fx_${Date.now() % 100000}_${i}`, arguments: JSON.stringify(tool.input) } }),
      ),
      sse({ type: 'response.completed', response: { id: 'resp_fx', usage: { input_tokens: 8, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } } } }),
    ].join('')
  }
  return [
    sse({ type: 'response.created', response: { id: 'resp_fx' } }),
    sse({ type: 'response.output_text.delta', delta: kind.final }),
    sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: kind.final }] } }),
    sse({ type: 'response.completed', response: { id: 'resp_fx', usage: { input_tokens: 8, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } } } }),
  ].join('')
}

function chatSse(kind: Emit): string {
  const toolList = 'tools' in kind ? kind.tools : 'tool' in kind ? [kind.tool] : []
  if (toolList.length > 0) {
    return [
      sse({ id: 'chat_fx', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: toolList.map((tool, i) => ({ index: i, id: `call_fx_${Date.now() % 100000}_${i}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.input) } })) } }] }),
      sse({ id: 'chat_fx', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 8, completion_tokens: 5 } }),
      'data: [DONE]\n\n',
    ].join('')
  }
  return [
    sse({ id: 'chat_fx', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: kind.final } }] }),
    sse({ id: 'chat_fx', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2 } }),
    'data: [DONE]\n\n',
  ].join('')
}

interface CrossfamilyFixtureOpts {
  port: number
  seatStyle?: 'instant' | 'paced'
  seatSleepSeconds?: number
  gptId?: string
  gptDisplayName?: string
  gptReasoningLevels?: readonly string[]
  nemotronId?: string
  captureLog?: string
}

interface CrossfamilyFixture {
  base: string
  captured: FixtureHit[]
  env: Record<string, string>
  refuseNextAnthropicSeat(status: number, message: string): void
  close(): Promise<void>
}

export async function startCrossfamilyFixture(opts: CrossfamilyFixtureOpts): Promise<CrossfamilyFixture> {
  const captured: FixtureHit[] = []
  const gptId = opts.gptId ?? 'gpt-5.5'
  const nemotronId = opts.nemotronId ?? 'openrouter/nvidia/nemotron-nano-9b-v2:free'
  const record = (hit: FixtureHit): void => {
    captured.push(hit)
    if (opts.captureLog !== undefined) {
      try {
        appendFileSync(opts.captureLog, JSON.stringify({ lane: hit.lane, path: hit.path, model: hit.model }) + '\n')
      } catch {
      }
    }
  }
  const seatStyle = opts.seatStyle ?? 'instant'
  const sleepS = opts.seatSleepSeconds ?? 6
  const seatRefusals: Array<{ status: number; message: string }> = []

  function seatScript(serialized: string, dialect: 'anthropic' | 'openai' | 'zai' | 'openrouter' | 'openrouter-responses' = 'anthropic'): string {
    const emit = dialect === 'anthropic' ? anthropicSse : dialect === 'openai' || dialect === 'openrouter-responses' ? responsesSse : chatSse
    const closed = /tool_result|function_call_output|"role":"tool"/.test(serialized)
    const marker = serialized.includes(CMA_STEER_TEXT.slice(0, 20))
      ? 'steer'
      : serialized.includes('seat-task-alpha')
        ? 'alpha'
        : serialized.includes('seat-task-plain')
          ? 'plain'
          : serialized.includes('seat-task-beta')
            ? 'beta'
            : serialized.includes('seat-task-gpt')
              ? 'gpt'
            : serialized.includes('seat-task-haiku')
              ? 'haiku'
            : serialized.includes('seat-task-nemotron')
              ? 'nemotron'
              : serialized.includes('seat-task-pair-one')
                ? 'pair-one'
                : serialized.includes('seat-task-pair-two')
                  ? 'pair-two'
                  : 'spare'
    if (seatStyle === 'paced' && !closed && (marker === 'alpha' || marker === 'beta')) {
      return emit({
        pre: `${marker}-live body. `,
        tool: { name: 'Bash', input: { command: `sleep ${sleepS}; echo ${marker}`, description: `${marker} pause` } },
      })
    }
    if (closed) return emit({ final: `${marker === 'steer' ? 'steer' : marker}-done body.` })
    return emit({ final: `${marker}-landed body.` })
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? ''
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(raw) as Record<string, unknown>
      } catch {
        body = {}
      }
      if (req.method === 'HEAD') {
        res.writeHead(200)
        res.end()
        return
      }
      if (req.method === 'GET') {
        if (path === '/openrouter/api/v1/models') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              data: [
                {
                  id: nemotronId.replace(/^openrouter\//, ''),
                  name: 'NVIDIA Nemotron Nano 9B (free)',
                  context_length: 131072,
                  pricing: { prompt: '0', completion: '0' },
                },
              ],
            }),
          )
          return
        }
        if (path === '/openrouter/api/v1/key') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ data: { label: 'fixture', usage: 0, limit: null, is_free_tier: true } }))
          return
        }
        if (path === '/openai/v1/models') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              models: [
                {
                  slug: gptId,
                  display_name: opts.gptDisplayName ?? gptId.toUpperCase(),
                  supported_reasoning_levels: (opts.gptReasoningLevels ?? ['high']).map(effort => ({ effort, description: effort })),
                  default_reasoning_level: 'high',
                  visibility: 'list',
                  priority: 1,
                  context_window: 272_000,
                  input_modalities: ['text'],
                  supported_in_api: true,
                },
              ],
            }),
          )
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [], models: [] }))
        return
      }
      if (req.method === 'POST' && path.endsWith('/v1/messages')) {
        record({ lane: 'anthropic-seat', path, model: String(body.model ?? ''), body })
        const refusal = seatRefusals.shift()
        if (refusal !== undefined) {
          res.writeHead(refusal.status, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: refusal.message } }))
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(seatScript(raw))
        return
      }
      if (req.method === 'POST' && path === '/openai/v1/responses') {
        record({ lane: 'openai-seat', path, model: String(body.model ?? ''), body })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(seatScript(raw, 'openai'))
        return
      }
      if (req.method === 'POST' && path === '/openrouter/api/v1/responses') {
        record({ lane: 'openrouter-seat', path, model: String(body.model ?? ''), body })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(seatScript(raw, 'openrouter-responses'))
        return
      }
      if (req.method === 'POST' && path === '/openrouter/api/v1/chat/completions') {
        record({ lane: 'openrouter-seat', path, model: String(body.model ?? ''), body })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(seatScript(raw, 'openrouter'))
        return
      }
      if (req.method === 'POST' && path === '/zai/v4/chat/completions') {
        record({ lane: 'zai-seat', path, model: String(body.model ?? ''), body })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(seatScript(raw, 'zai'))
        return
      }
      record({ lane: 'other', path: `${req.method} ${path}`, model: '', body })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const bound = typeof address === 'object' && address !== null ? address.port : opts.port
  const base = `http://127.0.0.1:${bound}`
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_API_KEY: 'fixture-key-000',
    MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
    MERCURY_OPENAI_CHATGPT_BASE: `${base}/openai/chatgpt`,
    MERCURY_OPENAI_AUTH_BASE: `${base}/openai/auth`,
    OPENAI_API_KEY: 'fixture-openai-key',
    MERCURY_ZAI_API_BASE: `${base}/zai/v4`,
    ZAI_API_KEY: 'fixture-zai-key',
    MERCURY_OPENROUTER_API_BASE: `${base}/openrouter/api/v1`,
    OPENROUTER_API_KEY: 'fixture-or-key',
  }
  return {
    base,
    captured,
    env,
    refuseNextAnthropicSeat: (status, message) => {
      seatRefusals.push({ status, message })
    },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}
