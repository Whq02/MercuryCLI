export type FoldTemplate = 'every-row' | 'after-last-user'

export interface FoldRow {
  role: string
  content?: unknown
  reasoning_content?: unknown
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
  tool_call_id?: string
}

export interface FoldReply {
  reasoning?: string
  text?: string
  call?: { name: string; arguments: Record<string, unknown> }
}

export interface FoldRequest {
  rows: FoldRow[]
  rendered: string
  promptTokens: number
  cachedTokens: number
  background: boolean
  maxTokens?: number
  thinkingBudget?: number
  aborted: boolean
  refused: boolean
  queued: boolean
}

const GENERATION_PROMPT = '<|im_start|>assistant\n<think>\n'

export function renderFoldPrompt(rows: readonly FoldRow[], template: FoldTemplate): string {
  const lastUser = rows.findLastIndex(row => row.role === 'user')
  let out = ''
  for (const [index, row] of rows.entries()) {
    const content = typeof row.content === 'string' ? row.content.trim() : ''
    if (row.role === 'assistant') {
      const reasoning = typeof row.reasoning_content === 'string' ? row.reasoning_content.trim() : ''
      const think = template === 'every-row' || index > lastUser ? `<think>\n${reasoning}\n</think>\n\n` : ''
      const calls = (row.tool_calls ?? []).map(call => `<tool_call>\n<function=${call.function?.name ?? ''}>\n${call.function?.arguments ?? ''}\n</function>\n</tool_call>`).join('\n')
      out += `<|im_start|>assistant\n${think}${content}${content !== '' && calls !== '' ? '\n\n' : ''}${calls}<|im_end|>\n`
    } else if (row.role === 'tool') {
      out += `<|im_start|>user\n<tool_response>\n${content}\n</tool_response><|im_end|>\n`
    } else {
      out += `<|im_start|>${row.role}\n${content}<|im_end|>\n`
    }
  }
  return out + GENERATION_PROMPT
}

export function foldTokens(rendered: string): string[] {
  return rendered.match(/[A-Za-z0-9_]+|[^A-Za-z0-9_\s]|\s+/g) ?? []
}

export function sharedFoldTokens(earlier: readonly string[], later: readonly string[]): number {
  let shared = 0
  while (shared < earlier.length && shared < later.length && earlier[shared] === later[shared]) shared++
  return shared
}

function foldReplyStarts(rendered: string): number[] {
  const starts: number[] = []
  const firstUser = rendered.indexOf('<|im_start|>user\n')
  if (firstUser > 0) starts.push(foldTokens(rendered.slice(0, firstUser)).length)
  for (let at = rendered.indexOf('<|im_start|>assistant\n'); at >= 0; at = rendered.indexOf('<|im_start|>assistant\n', at + 1)) starts.push(foldTokens(rendered.slice(0, at)).length)
  return starts
}

export interface TensorFoldPromptFixture {
  root: string
  model: string
  requests: FoldRequest[]
  reply(next: FoldReply): void
  holdBackground(ms: number, fromNth?: number): void
  holdNext(ms: number): void
  waiting(): number
  forget(): void
  beginDrain(): void
  stop(): void
}

const HELD_PROMPTS = 16

export interface TensorFoldPromptFixtureOptions {
  model: string
  template: FoldTemplate
  window?: number
  capabilities?: Record<string, boolean>
  resumesAt?: 'any-token' | 'reply-starts'
  showsLoad?: boolean
  refusesOpenCalls?: boolean
  letsGoAfterMs?: number
  serialForeground?: boolean
  earlyRole?: boolean
}

export function startTensorFoldPromptFixture(options: TensorFoldPromptFixtureOptions): TensorFoldPromptFixture {
  const window = options.window ?? 65536
  const requests: FoldRequest[] = []
  const replies: FoldReply[] = []
  let held: string[][] = []
  let calls = 0
  let backgroundHoldMs = 0
  let backgroundHoldFrom = 1
  let backgroundSeen = 0
  let nextHoldMs = 0
  let waiting = 0
  let queued = 0
  let backgroundHeld = 0
  let lettingGoUntil = 0
  let foreground: Promise<void> | undefined
  let draining = false
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request: Request) {
      const path = new URL(request.url).pathname
      const headers = { server: 'TensorFold' }
      if (path === '/health' && draining) return Response.json({ status: 'draining', requests_in_progress: waiting + queued }, { status: 503, headers })
      if (path === '/health') return Response.json({ status: 'ok', model: options.model, model_ids: [options.model], max_batch_size: 8, memory: { active: 1024 }, ...(options.showsLoad === false ? {} : { live: { connections: waiting + queued, waiting: queued, decode_tokens_per_second: 0, prefill_tokens_per_second: 0 } }), version: '1.2.7', backend: 'metal', device: 'fixture' }, { headers })
      if (path === '/v1/models') return Response.json({ object: 'list', data: [{ id: options.model, object: 'model', owned_by: 'tensorfold', context_length: window, max_model_len: window, reasoning: { default_enabled: true }, capabilities: { thinking_switch: true, ...(options.capabilities ?? {}) } }] }, { headers })
      if (path !== '/v1/chat/completions') return new Response('{}', { status: 404 })
      const body = JSON.parse(await request.text()) as { messages?: FoldRow[]; priority?: unknown; max_tokens?: unknown; thinking_budget?: unknown }
      const rows = body.messages ?? []
      const rendered = renderFoldPrompt(rows, options.template)
      const tokens = foldTokens(rendered)
      const shared = held.reduce((most, prompt) => Math.max(most, sharedFoldTokens(prompt, tokens)), 0)
      const cachedTokens = options.resumesAt === 'reply-starts' ? foldReplyStarts(rendered).reduce((most, start) => (start <= shared && start > most ? start : most), 0) : shared
      const background = body.priority === 'background'
      const entry: FoldRequest = { rows, rendered, promptTokens: tokens.length, cachedTokens, background, ...(typeof body.max_tokens === 'number' ? { maxTokens: body.max_tokens } : {}), ...(typeof body.thinking_budget === 'number' ? { thinkingBudget: body.thinking_budget } : {}), aborted: false, refused: false, queued: false }
      requests.push(entry)
      if (options.refusesOpenCalls === true && rows.some((row, index) => row.role === 'assistant' && (row.tool_calls?.length ?? 0) > 0 && rows[index + 1]?.role !== 'tool')) {
        entry.refused = true
        return Response.json({ error: { message: 'a tool call has no result after it', type: 'invalid_request_error' } }, { status: 400, headers })
      }
      const next = background ? { text: '.' } : replies.shift() ?? { text: 'done' }
      if (background) backgroundSeen += 1
      if (!background && options.letsGoAfterMs !== undefined && (backgroundHeld > 0 || Date.now() < lettingGoUntil)) {
        if (backgroundHeld > 0) lettingGoUntil = Math.max(lettingGoUntil, Date.now() + options.letsGoAfterMs)
        entry.queued = true
        queued += 1
        await new Promise(resolve => setTimeout(resolve, Math.max(0, lettingGoUntil - Date.now())))
        queued -= 1
      }
      const holdMs = background ? (backgroundSeen >= backgroundHoldFrom ? backgroundHoldMs : 0) : nextHoldMs
      if (!background) nextHoldMs = 0
      let release: (() => void) | undefined
      let owned: Promise<void> | undefined
      if (!background && options.serialForeground) {
        const before = foreground
        owned = new Promise<void>(resolve => { release = resolve })
        foreground = owned
        if (before !== undefined) {
          entry.queued = true
          queued += 1
          await before
          queued -= 1
        }
      }
      if (holdMs > 0) {
        waiting += 1
        if (background) backgroundHeld += 1
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, holdMs)
          request.signal.addEventListener('abort', () => {
            clearTimeout(timer)
            resolve()
          }, { once: true })
        })
        if (background) backgroundHeld -= 1
        waiting -= 1
      }
      release?.()
      if (owned !== undefined && foreground === owned) foreground = undefined
      if (request.signal.aborted) {
        entry.aborted = true
        if (background) lettingGoUntil = Math.max(lettingGoUntil, Date.now() + (options.letsGoAfterMs ?? 0))
        return new Response('', { status: 499 })
      }
      held = [...held.slice(-(HELD_PROMPTS - 1)), tokens]
      const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}): string => `data: ${JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', model: options.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`
      const reasoningTokens = foldTokens(next.reasoning ?? '').length
      const completion = reasoningTokens + foldTokens(next.text ?? '').length + (next.call === undefined ? 0 : foldTokens(JSON.stringify(next.call.arguments)).length)
      const stream = [
        chunk({ role: 'assistant' }),
        ...(next.reasoning !== undefined ? [chunk({ reasoning_content: next.reasoning })] : []),
        ...(next.text !== undefined ? [chunk({ content: next.text })] : []),
        ...(next.call !== undefined ? [chunk({ tool_calls: [{ index: 0, id: `call_${String(++calls).padStart(24, '0')}`, type: 'function', function: { name: next.call.name, arguments: JSON.stringify(next.call.arguments) } }] })] : []),
        chunk({}, next.call !== undefined ? 'tool_calls' : 'stop', { tensorfold: { enable_thinking: true, reasoning_effort: 'high', engine: 'lanes', tokens_per_second: 100, seconds: 0.01, prefill_seconds: 0.01, time_to_first_token: 0.01 } }),
        `data: ${JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', model: options.model, choices: [], usage: { prompt_tokens: tokens.length, completion_tokens: completion, total_tokens: tokens.length + completion, prompt_tokens_details: { cached_tokens: cachedTokens }, completion_tokens_details: { reasoning_tokens: reasoningTokens } } })}\n\n`,
        'data: [DONE]\n\n',
      ]
      return new Response(stream.join(''), { headers: { 'content-type': 'text/event-stream', ...headers } })
    },
  })
  const proxy = options.earlyRole ? Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request: Request) {
      const body = request.method === 'POST' ? await request.text() : undefined
      const upstream = fetch(`http://127.0.0.1:${server.port}${new URL(request.url).pathname}`, { method: request.method, headers: request.headers, ...(body !== undefined ? { body } : {}), signal: request.signal })
      if (body === undefined || JSON.parse(body).priority === 'background') return upstream
      return new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ model: options.model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`))
          try {
            const response = await upstream
            if (response.body !== null) for await (const chunk of response.body) controller.enqueue(chunk)
            controller.close()
          } catch (error) {
            controller.error(error)
          }
        },
      }), { headers: { 'content-type': 'text/event-stream' } })
    },
  }) : undefined
  return {
    root: `http://127.0.0.1:${proxy?.port ?? server.port}`,
    model: options.model,
    requests,
    reply: next => {
      replies.push(next)
    },
    holdBackground: (ms, fromNth = 1) => {
      backgroundHoldMs = ms
      backgroundHoldFrom = fromNth
    },
    holdNext: ms => {
      nextHoldMs = ms
    },
    waiting: () => waiting,
    forget: () => {
      held = []
      requests.length = 0
      backgroundSeen = 0
    },
    beginDrain: () => {
      draining = true
    },
    stop: () => {
      proxy?.stop(true)
      server.stop(true)
    },
  }
}
