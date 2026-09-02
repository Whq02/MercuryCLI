// ============================================================================
//  scripts/compact/overflowFixture.ts — the overflow ladder's loopback: ONE
//  server speaking the three wire dialects every routed family rides
//  (Anthropic messages · OpenAI Responses · chat-completions), answering a
//  per-request SCRIPT so a prover can stage "the first request overflows,
//  the fold's summary call answers, the retry answers" exactly, per family.
//  Every POST is captured with its dialect and parsed body — the wire truth
//  the laws are read from. Suite-local by design: its env block plants
//  credentials for families other suites deliberately probe keyless.
// ============================================================================
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export type Dialect = 'anthropic' | 'responses' | 'chat'
export type ScriptedCall = { id: string; name: string; args: string }
export type Turn =
  /** `finishReason` (chat dialect only): a provider-side termination word in
   *  place of 'stop' — Z.AI's documented `model_context_window_exceeded`. */
  | { text: string; usage?: { input: number; output: number }; finishReason?: string }
  | { calls: ScriptedCall[] }
  /** A refusal: the exact status and JSON body the family's wire sends. */
  | { error: { status: number; body: unknown } }
export type Captured = { dialect: Dialect; path: string; body: Record<string, unknown> }

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const evt = (name: string, obj: unknown): string => `event: ${name}\n${sse(obj)}`

function anthropicSse(turn: Exclude<Turn, { error: unknown }>, ordinal: number): string {
  const usage = {
    input_tokens: 'usage' in turn && turn.usage ? turn.usage.input : 8,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 'usage' in turn && turn.usage ? turn.usage.output : 3,
  }
  const out: string[] = [
    evt('message_start', { type: 'message_start', message: { id: `msg_${ordinal}`, type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage } }),
  ]
  if ('calls' in turn) {
    turn.calls.forEach((call, index) => {
      out.push(evt('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } }))
      out.push(evt('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: call.args } }))
      out.push(evt('content_block_stop', { type: 'content_block_stop', index }))
    })
    out.push(evt('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage }))
  } else {
    out.push(evt('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    out.push(evt('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: turn.text } }))
    out.push(evt('content_block_stop', { type: 'content_block_stop', index: 0 }))
    out.push(evt('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }))
  }
  out.push(evt('message_stop', { type: 'message_stop' }))
  return out.join('')
}

function responsesSse(turn: Exclude<Turn, { error: unknown }>, ordinal: number): string {
  const out: string[] = [sse({ type: 'response.created', response: { id: `resp_${ordinal}` } })]
  if ('calls' in turn) {
    turn.calls.forEach((call, index) => {
      const itemId = `fc_${ordinal}_${index}`
      out.push(sse({ type: 'response.output_item.added', item: { type: 'function_call', id: itemId, call_id: call.id, name: call.name, arguments: '' } }))
      out.push(sse({ type: 'response.function_call_arguments.delta', item_id: itemId, delta: call.args }))
      out.push(sse({ type: 'response.output_item.done', item: { type: 'function_call', id: itemId, call_id: call.id, name: call.name, arguments: call.args } }))
    })
  } else {
    out.push(sse({ type: 'response.output_text.delta', delta: turn.text }))
    out.push(sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: turn.text }] } }))
  }
  const input = 'usage' in turn && turn.usage ? turn.usage.input : 8
  const output = 'usage' in turn && turn.usage ? turn.usage.output : 3
  out.push(sse({ type: 'response.completed', response: { id: `resp_${ordinal}`, usage: { input_tokens: input, output_tokens: output, input_tokens_details: { cached_tokens: 0 } } } }))
  return out.join('')
}

function chatSse(turn: Exclude<Turn, { error: unknown }>): string {
  const out: string[] = []
  const input = 'usage' in turn && turn.usage ? turn.usage.input : 8
  const output = 'usage' in turn && turn.usage ? turn.usage.output : 3
  const usage = { prompt_tokens: input, completion_tokens: output, total_tokens: input + output }
  if ('calls' in turn) {
    turn.calls.forEach((call, index) => {
      out.push(sse({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: { ...(index === 0 ? { role: 'assistant' } : {}), tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: call.args } }] }, finish_reason: null }] }))
    })
    out.push(sse({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage }))
  } else {
    out.push(sse({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: turn.text }, finish_reason: null }] }))
    out.push(sse({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: turn.finishReason ?? 'stop' }], usage }))
  }
  out.push('data: [DONE]\n\n')
  return out.join('')
}

const OPENAI_MODELS_BODY = {
  models: [
    {
      slug: 'gpt-5.6-sol',
      display_name: 'GPT-5.6-Sol',
      supported_reasoning_levels: [{ effort: 'low', description: 'low' }, { effort: 'high', description: 'high' }],
      default_reasoning_level: 'low',
      visibility: 'list',
      priority: 1,
      context_window: 272_000,
      input_modalities: ['text', 'image'],
      supported_in_api: true,
    },
  ],
}

export interface OverflowFixture {
  base: string
  captured: Captured[]
  /** Install a fresh script: request N answers turns[N]; past the end the
   *  server answers a plain "script exhausted" text so a runaway loop is
   *  visible on the wire, never a hang. */
  script(turns: Turn[]): void
  /** The env pins for every family: bases AND fixture credentials. */
  env: Record<string, string>
  close(): Promise<void>
}

export async function startOverflowFixture(): Promise<OverflowFixture> {
  const captured: Captured[] = []
  let turns: Turn[] = [{ text: 'idle' }]
  let ordinal = 0
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? ''
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      } catch {
        body = {}
      }
      if (req.method === 'GET' && path.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          path.startsWith('/openai/')
            ? JSON.stringify(OPENAI_MODELS_BODY)
            : JSON.stringify({ object: 'list', data: [{ id: 'fixture-local', object: 'model', owned_by: 'fixture' }] }),
        )
        return
      }
      const dialect: Dialect | undefined = path.endsWith('/v1/messages')
        ? 'anthropic'
        : path.endsWith('/responses')
          ? 'responses'
          : path.endsWith('/chat/completions')
            ? 'chat'
            : undefined
      if (req.method === 'POST' && dialect !== undefined) {
        captured.push({ dialect, path, body })
        const turn = turns[ordinal] ?? { text: 'script exhausted' }
        const n = ordinal++
        if ('error' in turn) {
          res.writeHead(turn.error.status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(turn.error.body))
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(dialect === 'anthropic' ? anthropicSse(turn, n) : dialect === 'responses' ? responsesSse(turn, n) : chatSse(turn))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const base = `http://127.0.0.1:${port}`
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_AUTH_TOKEN: 'fixture-token',
    MERCURY_LOCAL_BASE_URL: base,
    MERCURY_COMPAT_BASE_URL: `${base}/v1`,
    MERCURY_COMPAT_API_KEY: 'fixture-compat-key',
    MERCURY_MOONSHOT_API_BASE: `${base}/moonshot/v1`,
    MERCURY_MOONSHOT_OAUTH_BASE: `${base}/moonshot/oauth`,
    MOONSHOT_API_KEY: 'fixture-moonshot-key',
    MERCURY_DEEPSEEK_API_BASE: `${base}/deepseek`,
    DEEPSEEK_API_KEY: 'fixture-deepseek-key',
    MERCURY_OPENROUTER_API_BASE: `${base}/openrouter/api/v1`,
    MERCURY_OPENROUTER_AUTH_BASE: `${base}/openrouter/auth`,
    OPENROUTER_API_KEY: 'fixture-openrouter-key',
    MERCURY_GEMINI_API_BASE: `${base}/gemini/v1beta`,
    MERCURY_GEMINI_OAUTH_AUTH_BASE: `${base}/gemini/oauth/auth`,
    MERCURY_GEMINI_OAUTH_TOKEN_BASE: `${base}/gemini/oauth/token`,
    GEMINI_API_KEY: 'fixture-gemini-key',
    MERCURY_HUGGINGFACE_API_BASE: `${base}/hf/v1`,
    MERCURY_HUGGINGFACE_HUB_BASE: `${base}/hf/hub`,
    HF_TOKEN: 'fixture-hf-token',
    MERCURY_ZAI_API_BASE: `${base}/zai/v4`,
    ZAI_API_KEY: 'fixture-zai-key',
    MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
    MERCURY_OPENAI_CHATGPT_BASE: `${base}/openai/chatgpt`,
    MERCURY_OPENAI_AUTH_BASE: `${base}/openai/auth`,
    OPENAI_API_KEY: 'fixture-openai-key',
  }
  return {
    base,
    captured,
    env,
    script(next: Turn[]): void {
      turns = next
      ordinal = 0
    },
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => resolve())
      }),
  }
}

/** The ten lanes and the model id that routes to each. */
export const OVERFLOW_LANES: ReadonlyArray<{ lane: string; model: string; dialect: Dialect }> = [
  { lane: 'anthropic', model: 'claude-opus-4-8', dialect: 'anthropic' },
  { lane: 'openai', model: 'gpt-5.6-sol', dialect: 'responses' },
  { lane: 'zai', model: 'glm-5.2', dialect: 'chat' },
  { lane: 'moonshot', model: 'kimi-k3', dialect: 'chat' },
  { lane: 'deepseek', model: 'deepseek-v4-pro', dialect: 'chat' },
  { lane: 'openai-compat', model: 'compat/fixture-model', dialect: 'chat' },
  { lane: 'openrouter', model: 'openrouter/fixture/model', dialect: 'chat' },
  { lane: 'gemini', model: 'gemini-3-pro', dialect: 'chat' },
  { lane: 'huggingface', model: 'huggingface/fixture-org/fixture-model', dialect: 'chat' },
  { lane: 'local', model: 'local/fixture-local', dialect: 'chat' },
]

/** The per-family overflow refusal as the wire sends it — the captured
 *  shapes the signal census classifies (status + body). */
export const OVERFLOW_WIRE_SHAPES: Record<string, { status: number; body: unknown; expect: { shape: string; actual?: number; limit?: number } }> = {
  anthropic: {
    status: 400,
    body: { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 213462 tokens > 200000 maximum' } },
    expect: { shape: 'prompt-too-long', actual: 213_462, limit: 200_000 },
  },
  openai: {
    status: 400,
    body: { error: { message: 'Your input exceeds the context window of this model. Please adjust your input and try again.', type: 'invalid_request_error', param: 'input', code: 'context_length_exceeded' } },
    expect: { shape: 'context-length-exceeded' },
  },
  zai: {
    status: 400,
    body: { error: { code: '1210', message: 'The number of tokens in the prompt exceeds the maximum context length of the model' } },
    expect: { shape: 'context-size' },
  },
  moonshot: {
    status: 400,
    body: { error: { message: 'Invalid request: Your request exceeded model token limit: 262144', type: 'invalid_request_error' } },
    expect: { shape: 'token-limit', limit: 262_144 },
  },
  deepseek: {
    status: 400,
    body: { error: { message: "This model's maximum context length is 131072 tokens. However, you requested 140123 tokens (135123 in the messages, 5000 in the completion). Please reduce the length of the messages or completion.", type: 'invalid_request_error', param: null, code: 'invalid_request_error' } },
    expect: { shape: 'context-length-exceeded', actual: 140_123, limit: 131_072 },
  },
  'openai-compat': {
    status: 400,
    body: { object: 'error', message: "This model's maximum context length is 32768 tokens. However, you requested 35000 tokens (34000 in the messages, 1000 in the completion). Please reduce the length of the messages or completion.", type: 'BadRequestError', param: null, code: 400 },
    expect: { shape: 'context-length-exceeded', actual: 35_000, limit: 32_768 },
  },
  openrouter: {
    status: 400,
    body: { error: { message: "This endpoint's maximum context length is 131072 tokens. However, you requested about 140000 tokens (135000 of text input, 5000 in the output). Please reduce the length of either one, or use the \"middle-out\" transform to compress your prompt automatically.", code: 400 } },
    expect: { shape: 'context-length-exceeded', actual: 140_000, limit: 131_072 },
  },
  gemini: {
    status: 400,
    body: { error: { code: 400, message: 'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).', status: 'INVALID_ARGUMENT' } },
    expect: { shape: 'input-token-limit', actual: 1_200_000, limit: 1_048_576 },
  },
  huggingface: {
    status: 422,
    body: { error: 'Input validation error: `inputs` tokens + `max_new_tokens` must be <= 32768. Given: 40000 `inputs` tokens and 1024 `max_new_tokens`', error_type: 'validation' },
    expect: { shape: 'input-validation', actual: 40_000, limit: 32_768 },
  },
  local: {
    status: 400,
    body: { error: { code: 400, message: 'the request exceeds the available context size. try increasing the context size or enable context shift', type: 'invalid_request_error' } },
    expect: { shape: 'context-size' },
  },
}
