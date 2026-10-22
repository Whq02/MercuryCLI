import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod/v4'

export const root = resolve(process.env.WARMTH_PROOF_ROOT ?? new URL('../..', import.meta.url).pathname)
export const dialects = ['chat-completions', 'responses', 'llamacpp', 'vllm', 'sglang', 'ollama', 'lmstudio'] as const
export type Capture = { path: string; body: any; cached: number; prefill: number; total: number; costMs: number }

export async function prepare() {
  if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
  mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
  delete process.env.MERCURY_HOME
  process.env.MERCURY_CREDENTIAL_STORE = 'file'
  process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  process.env.BROWSER = '/usr/bin/true'
  process.env.NODE_ENV = 'test'
  ;(globalThis as any).MACRO = { VERSION: '1.0.0', PACKAGE_URL: 'https://example.com/fixture' }
  const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import(`${root}/src/services/providers/credentialEnvSpellings.ts`)
  for (const name of [...ALL_PROVIDER_CREDENTIAL_ENV_VARS, 'MERCURY_COMPAT_BASE_URL', 'MERCURY_COMPAT_MODELS', 'MERCURY_COMPAT_LABEL']) delete process.env[name]
  for (const name of Object.keys(process.env)) if (/^MERCURY_COMPAT_.*_API_KEY$/.test(name)) delete process.env[name]
  const { enableConfigs } = await import(`${root}/src/utils/config.ts`)
  enableConfigs()
  return {
    ...await import(`${root}/src/utils/settings/settings.ts`),
    ...await import(`${root}/src/bootstrap/state.ts`),
    ...await import(`${root}/src/utils/messages.ts`),
    ...await import(`${root}/src/services/providers/callModelRouter.ts`),
    ...await import(`${root}/src/constants/prompts.ts`),
    ...await import(`${root}/src/utils/systemPromptType.ts`),
  }
}

export function fixtureTool(name = 'WarmthEcho', revision = 'first') {
  return { name, isMcp: false, isEnabled: () => true, isReadOnly: () => true, isConcurrencySafe: () => true, needsPermissions: () => false,
    prompt: async () => revision + ' echo', description: async () => revision + ' echo', inputSchema: z.object({ text: z.string() }),
    inputJSONSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } as never
}

export function startWarmthEngine() {
  const captures: Capture[] = []
  const cached = new Map<string, string>()
  const state = { slots: 4, mode: 'reply', report: true, cache: true, msPerToken: 0.002 }
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const path = new URL(req.url).pathname
    if (path.endsWith('/props')) return Response.json({ total_slots: state.slots })
    if (path.endsWith('/models')) return Response.json({ data: [{ id: 'Fixture/Reasoner', max_model_len: 262144 }] })
    if (!path.endsWith('/chat/completions') && !path.endsWith('/responses')) return new Response('not found', { status: 404 })
    const body: any = await req.json()
    const responses = path.endsWith('/responses')
    const prompt = JSON.stringify({ model: body.model, tools: body.tools, instructions: body.instructions }) + '\n' + (body.messages ?? body.input).map((row: unknown) => JSON.stringify(row)).join('\n') + '\n'
    const key = path + ':' + body.model + ':' + (body.id_slot ?? 'automatic')
    const previous = state.cache && body.cache_prompt !== false ? cached.get(key) ?? '' : ''
    let chars = 0
    while (chars < previous.length && chars < prompt.length && previous[chars] === prompt[chars]) chars++
    const hit = Math.floor(chars / 4)
    const total = Math.ceil(prompt.length / 4)
    const prefill = total - hit
    const costMs = prefill * state.msPerToken
    captures.push({ path, body, cached: hit, prefill, total, costMs })
    if (state.mode === 'refuse') return Response.json({ error: { message: 'fixture authentication refusal' } }, { status: 401 })
    if (state.mode === 'retry') { state.mode = 'reply'; return Response.json({ error: { message: 'fixture timeout' } }, { status: 408 }) }
    if (state.mode === 'cancel') return new Response(new ReadableStream({ start() {}, cancel() {} }), { headers: { 'content-type': 'text/event-stream' } })
    await Bun.sleep(costMs)
    cached.set(key, prompt)
    const usage = { prompt_tokens: total, completion_tokens: 4, ...(state.report ? { prompt_tokens_details: { cached_tokens: hit } } : {}) }
    if (responses) {
      const output = [{ id: 'msg-warmth', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'WARM', annotations: [] }] }]
      const frame = (type: string, extra: any) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`
      return new Response(frame('response.created', { response: { id: 'r-warmth', model: body.model, status: 'in_progress', output: [] } }) +
        frame('response.output_item.added', { output_index: 0, item: { ...output[0], content: [] } }) +
        frame('response.output_text.delta', { output_index: 0, content_index: 0, delta: 'WARM' }) +
        frame('response.output_item.done', { output_index: 0, item: output[0] }) +
        frame('response.completed', { response: { id: 'r-warmth', model: body.model, status: 'completed', output, usage: { input_tokens: total, output_tokens: 4, input_tokens_details: { cached_tokens: hit } } } }), { headers: { 'content-type': 'text/event-stream' } })
    }
    const chunk = (delta: unknown, finish: string | null = null, use?: unknown) => `data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(use ? { usage: use } : {}) })}\n\n`
    const toolCall = state.mode === 'tools'
    const delta = toolCall ? { tool_calls: [{ index: 0, id: 'call-warmth', type: 'function', function: { name: 'WarmthEcho', arguments: '{"text":"hello"}' } }] } : { content: 'WARM' }
    return new Response(chunk({ reasoning_content: 'thinking' }) + chunk(delta) + (state.mode === 'truncated' ? '' : chunk({}, toolCall ? 'tool_calls' : 'stop', usage) + 'data: [DONE]\n\n'), { headers: { 'content-type': 'text/event-stream' } })
  } })
  const base = `http://127.0.0.1:${server.port}`
  return { base, captures, state, clear: () => cached.clear(), close: () => server.stop(true) }
}

export async function configure(api: Awaited<ReturnType<typeof prepare>>, endpoints: Record<string, any>) {
  const result = api.updateSettingsForSource('userSettings', () => ({ compatProvider: endpoints }))
  if (result.error) throw result.error
}

export async function turn(api: Awaited<ReturnType<typeof prepare>>, model: string, messages: any[], opts: { owner?: string; agentId?: string; tools?: any[]; system?: any; signal?: AbortSignal } = {}) {
  const tools = opts.tools ?? [fixtureTool()]
  const out: any[] = []
  for await (const event of api.routedCallModel({ messages, tools, systemPrompt: opts.system ?? api.asSystemPrompt(['Fixture system']), thinkingConfig: { type: 'enabled', budgetTokens: 1024 }, signal: opts.signal ?? new AbortController().signal,
    options: { model, effortValue: 'max', ownerKey: opts.owner, agentId: opts.agentId, querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => ({}), agents: [], hasAppendSystemPrompt: false, mcpTools: [] } } as never)) if (event.type === 'assistant') out.push(event)
  return out
}
