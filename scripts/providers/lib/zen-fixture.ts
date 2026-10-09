import { strict as assert } from 'node:assert'

export type ZenFixtureMode = 'text' | 'tools' | 'malformed' | 'auth' | 'credits' | 'monthly-limit' | 'go-limit' | 'truncated' | 'free-tier'

export interface ZenFixtureCapture {
  path: string
  body: Record<string, any>
  headers: Record<string, string>
}

export interface ZenFixture {
  base: string
  goBase: string
  key: string
  goKey: string
  captures: ZenFixtureCapture[]
  listReads: number
  modelList: unknown[]
  mode: ZenFixtureMode
  stop(): void
}

const sse = (body: unknown): string => `data: ${JSON.stringify(body)}\n\n`
const errorBody = (type: string, message: string, metadata?: Record<string, unknown>): string =>
  JSON.stringify({ type: 'error', error: { type, message }, ...(metadata ? { metadata } : {}) })

export const ZEN_FIXTURE_LIVE_LIST: unknown[] = [
  { id: 'claude-fable-5-1', object: 'model', created: 1791524681, owned_by: 'opencode' },
  { id: 'gemini-3.1-pro', object: 'model', created: 1791524682, owned_by: 'opencode' },
  { id: 'gpt-5.5', object: 'model', created: 1791524683, owned_by: 'opencode' },
  { id: 'grok-4.7', object: 'model', created: 1791524684, owned_by: 'opencode' },
  { id: 'glm-5.3', object: 'model', created: 1791524685, owned_by: 'opencode' },
  { id: 'glm-5', object: 'model', created: 1791524686, owned_by: 'opencode' },
  { id: 'kimi-k3', object: 'model', created: 1791524687, owned_by: 'opencode' },
  { id: 'mistral-large-4', object: 'model', created: 1791524688, owned_by: 'opencode' },
  { id: 'qwen3.7-max', object: 'model', created: 1791524689, owned_by: 'opencode' },
  { id: 'jev-1.13', object: 'model', created: 1791524690, owned_by: 'opencode' },
  { id: 'big-pickle', object: 'model', created: 1791524691, owned_by: 'opencode' },
  { id: 'fixture-unpinned-model', object: 'model', created: 1791524692, owned_by: 'opencode' },
]

export function startZenFixture(opts: { key: string; goKey?: string; modelList?: unknown[] }): ZenFixture {
  const state = {
    captures: [] as ZenFixtureCapture[],
    listReads: 0,
    modelList: opts.modelList ?? [...ZEN_FIXTURE_LIVE_LIST],
    mode: 'text' as ZenFixtureMode,
  }
  const goKey = opts.goKey ?? `${opts.key}-go`
  const bearerOf = (req: Request): string | undefined => req.headers.get('authorization')?.match(/^Bearer (\S+)$/)?.[1]
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/zen/v1/models') {
      state.listReads++
      return Response.json({ object: 'list', data: state.modelList })
    }
    if (path === '/zen/go/v1/usage') {
      const bearer = bearerOf(req)
      if (bearer === undefined) return new Response(errorBody('AuthError', 'Missing API key.'), { status: 401, headers: { 'content-type': 'application/json' } })
      if (bearer === goKey) {
        const at = (sec: number): string => new Date(Date.now() + sec * 1000).toISOString()
        return Response.json({ usage: { rolling: { status: 'ok', percent: 12.5, resetsAt: at(3600) }, weekly: { status: 'ok', percent: 40, resetsAt: at(86400 * 3) }, monthly: { status: 'rate-limited', percent: 100, resetsAt: at(86400 * 20) } } })
      }
      if (bearer === opts.key) return new Response(errorBody('EntitlementError', 'OpenCode Go subscription required.'), { status: 403, headers: { 'content-type': 'application/json' } })
      return new Response(errorBody('AuthError', 'Unauthorized'), { status: 401, headers: { 'content-type': 'application/json' } })
    }
    assert.ok(path === '/zen/v1/chat/completions' || path === '/zen/v1/responses', `unexpected path ${path}`)
    assert.equal(req.method, 'POST')
    const raw = await req.text()
    assert.ok(!raw.includes(opts.key), 'the key never rides the body')
    const body = JSON.parse(raw)
    const headers: Record<string, string> = {}
    req.headers.forEach((value, name) => { headers[name] = value })
    state.captures.push({ path, body, headers })
    const bearer = bearerOf(req)
    const json = { 'content-type': 'application/json' }
    if (bearer === 'public') return new Response(errorBody('FreeTierError', "OpenCode's free tier can only be used from within OpenCode"), { status: 403, headers: json })
    if (bearer !== opts.key && bearer !== goKey) return new Response(errorBody('AuthError', 'Invalid API key.'), { status: 401, headers: json })
    if (state.mode === 'auth') return new Response(errorBody('AuthError', 'Invalid API key.'), { status: 401, headers: json })
    if (state.mode === 'credits') return new Response(errorBody('CreditsError', 'Insufficient balance. Add credits at https://opencode.ai/workspace/wrk_fixture/billing'), { status: 401, headers: json })
    if (state.mode === 'monthly-limit') return new Response(errorBody('MonthlyLimitError', 'The workspace monthly usage limit of $20 has been reached. Raise it at https://opencode.ai/workspace/wrk_fixture/billing'), { status: 401, headers: json })
    if (state.mode === 'go-limit') return new Response(errorBody('GoUsageLimitError', 'Weekly usage limit reached. It will reset in 2 days.', { workspace: 'wrk_fixture', limitName: 'weekly' }), { status: 429, headers: { ...json, 'retry-after': '172800' } })
    if (state.mode === 'free-tier') return new Response(errorBody('FreeTierError', "OpenCode's free tier can only be used from within OpenCode"), { status: 403, headers: json })
    const eventStream = { 'content-type': 'text/event-stream' }
    if (path === '/zen/v1/responses') {
      const id = 'resp_fixture'
      const ev = (type: string, extra: Record<string, unknown>): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`
      let out = ev('response.created', { response: { id, status: 'in_progress', output: [] } })
      const reasoning = { id: 'rs_fixture', type: 'reasoning', summary: [], encrypted_content: 'ENCRYPTED-FIXTURE-REASONING' }
      out += ev('response.output_item.added', { output_index: 0, item: reasoning })
      out += ev('response.output_item.done', { output_index: 0, item: reasoning })
      if (state.mode === 'tools' || state.mode === 'malformed') {
        const call = { id: 'fc_fixture', type: 'function_call', call_id: 'call_zen_fixture', name: 'FixtureEcho', arguments: '' }
        out += ev('response.output_item.added', { output_index: 1, item: call })
        out += ev('response.function_call_arguments.delta', { output_index: 1, item_id: 'fc_fixture', delta: state.mode === 'malformed' ? '{broken' : '{"text":"hello"}' })
        out += ev('response.function_call_arguments.done', { output_index: 1, item_id: 'fc_fixture', arguments: state.mode === 'malformed' ? '{broken' : '{"text":"hello"}' })
        out += ev('response.output_item.done', { output_index: 1, item: { ...call, arguments: state.mode === 'malformed' ? '{broken' : '{"text":"hello"}' } })
      } else {
        const message = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'in_progress', content: [] }
        out += ev('response.output_item.added', { output_index: 1, item: message })
        out += ev('response.output_text.delta', { output_index: 1, item_id: 'msg_fixture', content_index: 0, delta: 'ZEN-RESPONSES-SETTLED' })
        out += ev('response.output_text.done', { output_index: 1, item_id: 'msg_fixture', content_index: 0, text: 'ZEN-RESPONSES-SETTLED' })
        out += ev('response.output_item.done', { output_index: 1, item: { ...message, status: 'completed', content: [{ type: 'output_text', text: 'ZEN-RESPONSES-SETTLED', annotations: [] }] } })
      }
      if (state.mode === 'truncated') return new Response(out, { headers: eventStream })
      out += ev('response.completed', { response: { id, status: 'completed', output: [], usage: { input_tokens: 40, output_tokens: 20, input_tokens_details: { cached_tokens: 8 }, output_tokens_details: { reasoning_tokens: 6 } } } })
      out += `event: ping\ndata: ${JSON.stringify({ type: 'ping', cost: '0.00012000' })}\n\n`
      return new Response(out, { headers: eventStream })
    }
    const chunk = (delta: unknown, finish: string | null = null): string => sse({ id: 'zen-fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })
    let stream = chunk({ role: 'assistant', reasoning_content: 'fixture thought' })
    if (state.mode === 'tools' || state.mode === 'malformed') {
      stream += chunk({ tool_calls: [{ index: 0, id: 'call_zen_fixture', type: 'function', function: { name: 'FixtureEcho', arguments: state.mode === 'malformed' ? '{broken' : '{"text":' } }] })
      if (state.mode === 'tools') stream += chunk({ tool_calls: [{ index: 0, function: { arguments: '"hello"}' } }] })
      stream += chunk({}, 'tool_calls')
    } else {
      stream += chunk({ content: 'ZEN-CHAT-SETTLED' })
      if (state.mode !== 'truncated') stream += chunk({}, 'stop')
    }
    if (state.mode === 'truncated') return new Response(stream, { headers: eventStream })
    stream += sse({ choices: [], usage: { prompt_tokens: 32, completion_tokens: 103, total_tokens: 135, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 94 } } })
    stream += 'data: [DONE]\n\n'
    stream += sse({ choices: [], cost: '0.00045600' })
    return new Response(stream, { headers: eventStream })
  } })
  return {
    base: `http://127.0.0.1:${server.port}/zen/v1`,
    goBase: `http://127.0.0.1:${server.port}/zen/go/v1`,
    key: opts.key,
    goKey,
    get captures() { return state.captures },
    get listReads() { return state.listReads },
    get modelList() { return state.modelList },
    set modelList(value: unknown[]) { state.modelList = value },
    get mode() { return state.mode },
    set mode(value: ZenFixtureMode) { state.mode = value },
    stop: () => server.stop(true),
  }
}
