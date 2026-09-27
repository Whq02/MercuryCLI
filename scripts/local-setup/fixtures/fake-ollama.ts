#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname } from 'node:path'

export const FAKE_OLLAMA_VERSION = '0.34.4'
export const FAKE_OLLAMA_MODEL = 'qwen3.5:9b'
export const FAKE_OLLAMA_LIBRARY: ReadonlySet<string> = new Set([FAKE_OLLAMA_MODEL, 'qwen3.5:9b-q4_K_M'])
export const FAKE_OLLAMA_MODEL_SIZE = 6_594_474_711
export const FAKE_OLLAMA_MODEL_DIGEST = '6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7'
export const FAKE_OLLAMA_TRAINED_CONTEXT = 262_144
export const FAKE_OLLAMA_DEFAULT_CONTEXT = 4096
export const FAKE_OLLAMA_REPLY = 'ready'
export const FAKE_OLLAMA_REPLY_PREFIX = 'ready — the fixture qwen3.5:9b heard: '
const HARNESS_BLOCK = /^<(?:system-reminder|local-command-[a-z]+|command-[a-z]+)>/
export const FAKE_OLLAMA_PROMPT_PACE_TOKENS_PER_S = 300
export const FAKE_OLLAMA_EVAL_PACE_TOKENS_PER_S = 40

export const FAKE_OLLAMA_LAYERS: ReadonlyArray<{ digest: string; total: number }> = [
  { digest: 'sha256:dec52a44569a2a25341c4e4d3fee25846eed4f6f0b936278e3a3c900bb99d37c', total: 6_594_463_202 },
  { digest: 'sha256:a70ff7e570d97baaf4e62ac6e6ad9975e04caa6d900d3742d37eb8bb3f4ee7d5', total: 11_357 },
  { digest: 'sha256:1a1f0b2e4c3d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f', total: 152 },
]

export const FAKE_OLLAMA_DETAILS = {
  parent_model: '',
  format: 'gguf',
  family: 'qwen35',
  families: ['qwen35'],
  parameter_size: '9.7B',
  quantization_level: 'Q4_K_M',
}

export const FAKE_OLLAMA_CAPABILITIES: readonly string[] = ['completion', 'vision', 'tools', 'thinking']

export const FAKE_OLLAMA_MODEL_INFO: Record<string, unknown> = {
  'general.architecture': 'qwen35',
  'general.file_type': 15,
  'general.parameter_count': 9_653_104_368,
  'general.quantization_version': 2,
  'qwen35.attention.head_count': 16,
  'qwen35.attention.head_count_kv': [0, 0, 0, 4, 0, 0, 0, 4, 0, 0, 0, 4, 0, 0, 0, 4, 0, 0, 0, 4, 0, 0, 0, 4, 0, 0, 0, 4, 0, 0, 0, 4],
  'qwen35.attention.key_length': 256,
  'qwen35.attention.layer_norm_rms_epsilon': 0.000001,
  'qwen35.attention.value_length': 256,
  'qwen35.block_count': 32,
  'qwen35.context_length': FAKE_OLLAMA_TRAINED_CONTEXT,
  'qwen35.embedding_length': 4096,
  'qwen35.feed_forward_length': 12_288,
  'qwen35.full_attention_interval': 4,
  'qwen35.rope.dimension_count': 64,
  'qwen35.rope.freq_base': 10_000_000,
  'tokenizer.ggml.add_eos_token': false,
  'tokenizer.ggml.eos_token_id': 248_046,
  'tokenizer.ggml.model': 'gpt2',
  'tokenizer.ggml.padding_token_id': 248_044,
  'tokenizer.ggml.pre': 'qwen35',
}

export const FAKE_OLLAMA_PARAMETERS = 'top_p                          0.95\npresence_penalty               1.5\ntemperature                    1\ntop_k                          20'

export interface FakeOllamaRequest {
  at: number
  method: string
  path: string
  body: unknown
}

export interface FakeOllamaOptions {
  pulled?: readonly string[]
  pullStepMs?: number
  pullSteps?: number
  chatDelayMs?: number
  chatStepMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  onRequest?: (entry: FakeOllamaRequest) => void
}

export interface FakeOllamaResponse {
  status: number
  headers: Record<string, string>
  body: string | AsyncIterable<string>
}

export interface FakeOllamaLoaded {
  contextLength: number
  expiresAt: string
}

export interface FakeOllamaState {
  pulled: Set<string>
  loaded: Map<string, FakeOllamaLoaded>
  requests: FakeOllamaRequest[]
}

export interface FakeOllama {
  handle(method: string, path: string, rawBody: string): Promise<FakeOllamaResponse>
  state: FakeOllamaState
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }
const NDJSON_HEADERS = { 'content-type': 'application/x-ndjson' }
const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }
const TEXT_HEADERS = { 'content-type': 'text/plain; charset=utf-8' }

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

function parseBody(raw: string): unknown {
  if (raw.trim() === '') return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

function row(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`
}

function tokensOf(text: string): number {
  return Math.max(1, Math.round(text.length / 4))
}

function pieces(text: string): string[] {
  const out: string[] = []
  for (const part of text.split(/(?<=\s)/)) if (part !== '') out.push(part)
  return out.length > 0 ? out : [text]
}

export function fakeOllamaReplyFor(prompt: string): string {
  const line = prompt.trim().split('\n').find(l => l.trim() !== '')?.trim() ?? ''
  if (/\bready\b/i.test(line)) return FAKE_OLLAMA_REPLY
  return `${FAKE_OLLAMA_REPLY_PREFIX}${line.slice(0, 80)}`
}

export function tagEntry(tag: string, modifiedAt: string): Record<string, unknown> {
  return {
    name: tag,
    model: tag,
    modified_at: modifiedAt,
    size: FAKE_OLLAMA_MODEL_SIZE,
    digest: FAKE_OLLAMA_MODEL_DIGEST,
    details: { ...FAKE_OLLAMA_DETAILS, context_length: FAKE_OLLAMA_TRAINED_CONTEXT, embedding_length: 4096 },
    capabilities: [...FAKE_OLLAMA_CAPABILITIES],
  }
}

export function showBody(tag: string, modifiedAt: string): Record<string, unknown> {
  return {
    thinking: { values: [false, true], default: true },
    license: 'Apache License\nVersion 2.0, January 2004\nhttp://www.apache.org/licenses/',
    modelfile: `# Modelfile generated by "ollama show"\n# To build a new Modelfile based on this, replace FROM with:\n# FROM ${tag}\n\nFROM /models/blobs/${FAKE_OLLAMA_LAYERS[0]!.digest.replace(':', '-')}\nTEMPLATE {{ .Prompt }}\nRENDERER qwen3.5\nPARSER qwen3.5\nPARAMETER top_p 0.95\nPARAMETER presence_penalty 1.5\nPARAMETER temperature 1\nPARAMETER top_k 20\nLICENSE """Apache License"""`,
    parameters: FAKE_OLLAMA_PARAMETERS,
    template: '{{ .Prompt }}',
    details: { ...FAKE_OLLAMA_DETAILS },
    model_info: { ...FAKE_OLLAMA_MODEL_INFO },
    capabilities: [...FAKE_OLLAMA_CAPABILITIES],
    modified_at: modifiedAt,
    requires: '0.17.1',
  }
}

export function createFakeOllama(options: FakeOllamaOptions = {}): FakeOllama {
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const pullStepMs = options.pullStepMs ?? 120
  const pullSteps = Math.max(1, options.pullSteps ?? 24)
  const chatDelayMs = options.chatDelayMs ?? 0
  const chatStepMs = options.chatStepMs ?? 20
  const state: FakeOllamaState = { pulled: new Set(options.pulled ?? []), loaded: new Map(), requests: [] }
  const modifiedAt = new Map<string, string>()
  for (const tag of state.pulled) modifiedAt.set(tag, new Date(now()).toISOString())
  const iso = (): string => new Date(now()).toISOString()
  const expiry = (): string => new Date(now() + 5 * 60_000).toISOString()

  const json = (status: number, body: unknown): FakeOllamaResponse => ({ status, headers: JSON_HEADERS, body: JSON.stringify(body) })
  const notFound = (tag: string): FakeOllamaResponse => json(404, { error: `model '${tag}' not found` })
  const notPulled = (tag: string): FakeOllamaResponse => json(404, { error: `model '${tag}' not found, try pulling it first` })

  const tagOf = (body: Record<string, unknown> | undefined): string => {
    const raw = body?.model ?? body?.name
    return typeof raw === 'string' ? raw.trim() : ''
  }

  const contextOf = (body: Record<string, unknown> | undefined): number | undefined => {
    const numCtx = rec(body?.options)?.num_ctx
    return typeof numCtx === 'number' && Number.isFinite(numCtx) && numCtx > 0 ? Math.floor(numCtx) : undefined
  }

  const load = (tag: string, body: Record<string, unknown> | undefined): FakeOllamaLoaded => {
    const keepAlive = body?.keep_alive
    if (keepAlive === 0 || keepAlive === '0' || keepAlive === '0s') {
      state.loaded.delete(tag)
      return { contextLength: 0, expiresAt: iso() }
    }
    const before = state.loaded.get(tag)
    const contextLength = contextOf(body) ?? before?.contextLength ?? FAKE_OLLAMA_DEFAULT_CONTEXT
    const entry = { contextLength, expiresAt: expiry() }
    state.loaded.set(tag, entry)
    return entry
  }

  const psEntry = (tag: string, loaded: FakeOllamaLoaded): Record<string, unknown> => ({
    name: tag,
    model: tag,
    size: FAKE_OLLAMA_MODEL_SIZE + loaded.contextLength * 32_768,
    digest: FAKE_OLLAMA_MODEL_DIGEST,
    details: { ...FAKE_OLLAMA_DETAILS },
    expires_at: loaded.expiresAt,
    size_vram: FAKE_OLLAMA_MODEL_SIZE + loaded.contextLength * 32_768,
    context_length: loaded.contextLength,
  })

  async function* pullRows(tag: string): AsyncIterable<string> {
    yield row({ status: 'pulling manifest' })
    await sleep(pullStepMs)
    for (const [index, layer] of FAKE_OLLAMA_LAYERS.entries()) {
      const short = layer.digest.slice(7, 19)
      const steps = index === 0 ? pullSteps : 1
      yield row({ status: `pulling ${short}`, digest: layer.digest, total: layer.total })
      for (let step = 1; step <= steps; step++) {
        await sleep(pullStepMs)
        yield row({ status: `pulling ${short}`, digest: layer.digest, total: layer.total, completed: Math.round((layer.total * step) / steps) })
      }
    }
    yield row({ status: 'verifying sha256 digest' })
    await sleep(pullStepMs)
    yield row({ status: 'writing manifest' })
    state.pulled.add(tag)
    modifiedAt.set(tag, iso())
    yield row({ status: 'success' })
  }

  const timings = (promptText: string, reply: string): Record<string, number> => {
    const promptTokens = tokensOf(promptText)
    const evalTokens = tokensOf(reply)
    const loadDuration = chatDelayMs * 1_000_000
    const promptDuration = Math.round((promptTokens / FAKE_OLLAMA_PROMPT_PACE_TOKENS_PER_S) * 1e9)
    const evalDuration = Math.round((evalTokens / FAKE_OLLAMA_EVAL_PACE_TOKENS_PER_S) * 1e9)
    return {
      total_duration: loadDuration + promptDuration + evalDuration,
      load_duration: loadDuration,
      prompt_eval_count: promptTokens,
      prompt_eval_duration: promptDuration,
      eval_count: evalTokens,
      eval_duration: evalDuration,
    }
  }

  const lastUserText = (body: Record<string, unknown> | undefined): string => {
    const messages = Array.isArray(body?.messages) ? (body!.messages as unknown[]) : []
    let tagged = ''
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = rec(messages[i])
      if (m?.role !== 'user') continue
      const text = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map(part => (typeof rec(part)?.text === 'string' ? String(rec(part)!.text) : '')).join('') : ''
      if (HARNESS_BLOCK.test(text.trimStart())) {
        if (tagged === '') tagged = text
        continue
      }
      return text
    }
    if (tagged !== '') return tagged
    return typeof body?.prompt === 'string' ? body.prompt : ''
  }

  const promptTextOf = (body: Record<string, unknown> | undefined): string => {
    const messages = Array.isArray(body?.messages) ? (body!.messages as unknown[]) : []
    const parts = messages.map(m => {
      const content = rec(m)?.content
      return typeof content === 'string' ? content : JSON.stringify(content ?? '')
    })
    if (typeof body?.prompt === 'string') parts.push(body.prompt)
    if (body?.tools !== undefined) parts.push(JSON.stringify(body.tools))
    return parts.join('\n')
  }

  async function* chatRows(tag: string, body: Record<string, unknown> | undefined): AsyncIterable<string> {
    const reply = fakeOllamaReplyFor(lastUserText(body))
    const stats = timings(promptTextOf(body), reply)
    await sleep(chatDelayMs)
    if (body?.think === true) {
      yield row({ model: tag, created_at: iso(), message: { role: 'assistant', content: '', thinking: 'The user wants one word.' }, done: false })
      await sleep(chatStepMs)
    }
    for (const piece of pieces(reply)) {
      yield row({ model: tag, created_at: iso(), message: { role: 'assistant', content: piece }, done: false })
      await sleep(chatStepMs)
    }
    yield row({ model: tag, created_at: iso(), message: { role: 'assistant', content: '' }, done_reason: 'stop', done: true, ...stats })
  }

  async function* generateRows(tag: string, body: Record<string, unknown> | undefined): AsyncIterable<string> {
    const reply = fakeOllamaReplyFor(lastUserText(body))
    const stats = timings(promptTextOf(body), reply)
    await sleep(chatDelayMs)
    for (const piece of pieces(reply)) {
      yield row({ model: tag, created_at: iso(), response: piece, done: false })
      await sleep(chatStepMs)
    }
    yield row({ model: tag, created_at: iso(), response: '', done: true, done_reason: 'stop', context: [1, 2, 3], ...stats })
  }

  async function* completionChunks(tag: string, body: Record<string, unknown> | undefined): AsyncIterable<string> {
    const reply = fakeOllamaReplyFor(lastUserText(body))
    const stats = timings(promptTextOf(body), reply)
    const id = `chatcmpl-${now().toString(36)}`
    const created = Math.floor(now() / 1000)
    const chunk = (delta: Record<string, unknown>, finish: string | null, extra: Record<string, unknown> = {}): string =>
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: tag, system_fingerprint: 'fp_ollama', choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`
    await sleep(chatDelayMs)
    yield chunk({ role: 'assistant', content: '' }, null)
    for (const piece of pieces(reply)) {
      yield chunk({ content: piece }, null)
      await sleep(chatStepMs)
    }
    yield chunk({}, 'stop', { usage: { prompt_tokens: stats.prompt_eval_count, completion_tokens: stats.eval_count, total_tokens: stats.prompt_eval_count! + stats.eval_count! } })
    yield 'data: [DONE]\n\n'
  }

  const drain = async (rows: AsyncIterable<string>): Promise<string[]> => {
    const out: string[] = []
    for await (const line of rows) out.push(line)
    return out
  }

  async function handle(method: string, path: string, rawBody: string): Promise<FakeOllamaResponse> {
    const parsed = parseBody(rawBody)
    const body = rec(parsed)
    const entry: FakeOllamaRequest = { at: now(), method, path, body: parsed }
    state.requests.push(entry)
    options.onRequest?.(entry)
    const route = `${method} ${path}`

    if (route === 'GET /' || route === 'HEAD /') return { status: 200, headers: TEXT_HEADERS, body: 'Ollama is running' }
    if (route === 'GET /api/version') return json(200, { version: FAKE_OLLAMA_VERSION })
    if (route === 'GET /api/tags') return json(200, { models: [...state.pulled].map(tag => tagEntry(tag, modifiedAt.get(tag) ?? iso())) })
    if (route === 'GET /api/ps') return json(200, { models: [...state.loaded].map(([tag, loaded]) => psEntry(tag, loaded)) })
    if (route === 'GET /v1/models') return json(200, { object: 'list', data: [...state.pulled].map(tag => ({ id: tag, object: 'model', created: Math.floor(now() / 1000), owned_by: 'library' })) })

    if (method === 'POST' && parsed === null) return json(400, { error: 'invalid JSON body' })

    if (route === 'POST /api/show') {
      const tag = tagOf(body)
      if (!state.pulled.has(tag)) return notFound(tag)
      return json(200, showBody(tag, modifiedAt.get(tag) ?? iso()))
    }
    if (route === 'POST /api/pull') {
      const tag = tagOf(body)
      if (!FAKE_OLLAMA_LIBRARY.has(tag)) return json(500, { error: 'pull model manifest: file does not exist' })
      if (body?.stream === false) {
        await drain(pullRows(tag))
        return json(200, { status: 'success' })
      }
      return { status: 200, headers: NDJSON_HEADERS, body: pullRows(tag) }
    }
    if (route === 'POST /api/delete' || route === 'DELETE /api/delete') {
      const tag = tagOf(body)
      if (!state.pulled.has(tag)) return notFound(tag)
      state.pulled.delete(tag)
      state.loaded.delete(tag)
      return json(200, { status: 'success' })
    }
    if (route === 'POST /api/generate') {
      const tag = tagOf(body)
      if (!state.pulled.has(tag)) return notPulled(tag)
      const loaded = load(tag, body)
      if (typeof body?.prompt !== 'string' || body.prompt === '') {
        return json(200, { model: tag, created_at: iso(), response: '', done: true, done_reason: loaded.contextLength === 0 ? 'unload' : 'load' })
      }
      if (body.stream === false) {
        const lines = await drain(generateRows(tag, body))
        const last = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>
        const text = lines.slice(0, -1).map(l => String((JSON.parse(l) as { response: string }).response)).join('')
        return json(200, { ...last, response: text })
      }
      return { status: 200, headers: NDJSON_HEADERS, body: generateRows(tag, body) }
    }
    if (route === 'POST /api/chat') {
      const tag = tagOf(body)
      if (!state.pulled.has(tag)) return notPulled(tag)
      const loaded = load(tag, body)
      if (!Array.isArray(body?.messages) || body.messages.length === 0) {
        return json(200, { model: tag, created_at: iso(), message: { role: 'assistant', content: '' }, done: true, done_reason: loaded.contextLength === 0 ? 'unload' : 'load' })
      }
      if (body.stream === false) {
        const lines = await drain(chatRows(tag, body))
        const last = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>
        const text = lines.slice(0, -1).map(l => String((JSON.parse(l) as { message: { content: string } }).message.content)).join('')
        return json(200, { ...last, message: { role: 'assistant', content: text } })
      }
      return { status: 200, headers: NDJSON_HEADERS, body: chatRows(tag, body) }
    }
    if (route === 'POST /v1/chat/completions') {
      const tag = tagOf(body)
      if (!state.pulled.has(tag)) return json(404, { error: { message: `model '${tag}' not found`, type: 'api_error', param: null, code: null } })
      load(tag, body)
      if (body?.stream === true) return { status: 200, headers: SSE_HEADERS, body: completionChunks(tag, body) }
      const reply = fakeOllamaReplyFor(lastUserText(body))
      const stats = timings(promptTextOf(body), reply)
      return json(200, {
        id: `chatcmpl-${now().toString(36)}`,
        object: 'chat.completion',
        created: Math.floor(now() / 1000),
        model: tag,
        system_fingerprint: 'fp_ollama',
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: stats.prompt_eval_count, completion_tokens: stats.eval_count, total_tokens: stats.prompt_eval_count! + stats.eval_count! },
      })
    }
    return { status: 404, headers: TEXT_HEADERS, body: '404 page not found' }
  }

  return { handle, state }
}

function streamOf(rows: AsyncIterable<string>): ReadableStream<Uint8Array> {
  const iterator = rows[Symbol.asyncIterator]()
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next()
      if (next.done) controller.close()
      else controller.enqueue(encoder.encode(next.value))
    },
    cancel() {
      void iterator.return?.()
    },
  })
}

export function fakeOllamaFetch(fixture: FakeOllama): typeof fetch {
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    let rawBody = ''
    if (typeof init?.body === 'string') rawBody = init.body
    else if (init?.body instanceof Uint8Array) rawBody = Buffer.from(init.body).toString('utf8')
    else if (input instanceof Request && init?.body === undefined) rawBody = await input.text()
    const answer = await fixture.handle(method, new URL(url).pathname, rawBody)
    return new Response(typeof answer.body === 'string' ? answer.body : streamOf(answer.body), { status: answer.status, headers: answer.headers })
  }
  return impl as typeof fetch
}

export function serveFakeOllama(fixture: FakeOllama, port: number, host = '127.0.0.1'): Promise<{ server: Server; port: number; root: string }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const path = (req.url ?? '/').split('?')[0] ?? '/'
      void fixture.handle((req.method ?? 'GET').toUpperCase(), path, Buffer.concat(chunks).toString('utf8')).then(async answer => {
        res.writeHead(answer.status, answer.headers)
        if (typeof answer.body === 'string') {
          res.end(answer.body)
          return
        }
        try {
          for await (const line of answer.body) {
            if (res.destroyed) break
            res.write(line)
          }
        } finally {
          res.end()
        }
      })
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const address = server.address()
      const bound = typeof address === 'object' && address !== null ? address.port : port
      resolve({ server, port: bound, root: `http://${host}:${bound}` })
    })
  })
}

export function parseOllamaHost(raw: string | undefined): { host: string; port: number } | undefined {
  const value = raw?.trim()
  if (!value) return undefined
  const m = /^(?:https?:\/\/)?([^:/]+)?(?::(\d+))?\/?$/.exec(value)
  if (!m) return undefined
  return { host: m[1] ?? '127.0.0.1', port: m[2] !== undefined ? Number(m[2]) : 11434 }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(name)
    return at >= 0 ? argv[at + 1] : undefined
  }
  const env = process.env
  const bind = parseOllamaHost(env.OLLAMA_HOST)
  const port = Number(flag('--port') ?? env.FAKE_OLLAMA_PORT ?? bind?.port ?? 0)
  const host = flag('--host') ?? bind?.host ?? '127.0.0.1'
  const log = flag('--log') ?? env.FAKE_OLLAMA_LOG
  const pidfile = flag('--pidfile') ?? env.FAKE_OLLAMA_PIDFILE
  const parentPid = Number(flag('--parent-pid') ?? env.FAKE_OLLAMA_PARENT_PID ?? 0)
  const pulled = [...argv.flatMap((a, i) => (a === '--pulled' ? [argv[i + 1] ?? ''] : [])), ...(env.FAKE_OLLAMA_PULLED ?? '').split(',')].map(s => s.trim()).filter(s => s !== '')
  const numberFlag = (name: string, envName: string): number | undefined => {
    const raw = flag(name) ?? env[envName]
    return raw === undefined || raw === '' ? undefined : Number(raw)
  }
  const fixture = createFakeOllama({
    pulled,
    pullStepMs: numberFlag('--pull-step-ms', 'FAKE_OLLAMA_PULL_STEP_MS'),
    pullSteps: numberFlag('--pull-steps', 'FAKE_OLLAMA_PULL_STEPS'),
    chatDelayMs: numberFlag('--chat-delay-ms', 'FAKE_OLLAMA_CHAT_DELAY_MS'),
    chatStepMs: numberFlag('--chat-step-ms', 'FAKE_OLLAMA_CHAT_STEP_MS'),
    onRequest: log
      ? entry => {
          try {
            mkdirSync(dirname(log), { recursive: true })
            appendFileSync(log, `${JSON.stringify(entry)}\n`)
          } catch {
            void 0
          }
        }
      : undefined,
  })
  const served = await serveFakeOllama(fixture, Number.isFinite(port) ? port : 0, host)
  if (pidfile) {
    mkdirSync(dirname(pidfile), { recursive: true })
    writeFileSync(pidfile, `${process.pid}\n`)
  }
  console.log(`PORT ${served.port}`)
  console.log(`ROOT ${served.root}`)
  const leave = (): void => {
    if (pidfile && existsSync(pidfile)) {
      try {
        unlinkSync(pidfile)
      } catch {
        void 0
      }
    }
    served.server.close()
    process.exit(0)
  }
  process.on('SIGTERM', leave)
  process.on('SIGINT', leave)
  if (parentPid > 0) {
    const watch = setInterval(() => {
      try {
        process.kill(parentPid, 0)
      } catch {
        leave()
      }
    }, 2000)
    watch.unref()
  }
}
