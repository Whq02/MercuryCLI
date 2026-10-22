import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod/v4'

export async function llmhostFixture(options: { model?: string } = {}) {
  const root = resolve(process.env.LLMHOST_PROOF_ROOT ?? join(import.meta.dir, '../../..'))
  if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
  mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
  const home = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR, 'llmhost-'))
  delete process.env.MERCURY_HOME
  process.env.MERCURY_CONFIG_DIR = home
  process.env.MERCURY_CREDENTIAL_STORE = 'file'
  process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  process.env.BROWSER = '/usr/bin/true'
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import(`${root}/src/services/providers/credentialEnvSpellings.ts`)
  for (const key of [...ALL_PROVIDER_CREDENTIAL_ENV_VARS, 'MERCURY_COMPAT_BASE_URL', 'MERCURY_COMPAT_MODELS', 'MERCURY_COMPAT_LABEL', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC']) delete process.env[key]
  for (const key of Object.keys(process.env)) if (/^MERCURY_COMPAT_.*_API_KEY$/.test(key)) delete process.env[key]
  const events: any[] = []
  const captures: Array<{ path: string; body: any; auth: string | null; affinity: string | null }> = []
  const state = { dialect: 'vllm', window: 1_048_576, slots: 1, field: 'max_model_len', mode: 'reply', auth: false, listed: true, requests: 0, propsRequests: 0, thinkingValues: [] as Array<string | boolean>, modelIds: [options.model ?? 'Fixture/Reasoner'], vision: undefined as boolean | undefined, inputModalities: undefined as string[] | undefined }
  const model = options.model ?? 'Fixture/Reasoner'
  const key = 'proof-key-llmhost-fixture-not-a-real-key'
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    state.requests++
    const path = new URL(req.url).pathname
    if (state.auth && req.headers.get('authorization') !== `Bearer ${key}`) return Response.json({ error: { message: 'fixture key required' } }, { status: 401 })
    if (path === '/v1/models') return Response.json({ data: state.listed ? state.modelIds.map(id => ({ id, owned_by: state.dialect, ...(state.field ? { [state.field]: state.window } : {}), ...(state.inputModalities ? { architecture: { input_modalities: state.inputModalities } } : {}) })) : [] })
    if (path === '/model_info' && state.dialect === 'sglang') return Response.json({ model_path: model, served_model_name: model, tokenizer_path: model, is_generation: true, reasoning_parser: 'qwen3', tool_call_parser: 'qwen', has_image_understanding: state.inputModalities ? state.inputModalities.includes('image') : true, has_audio_understanding: false })
    if (path === '/props' && state.dialect === 'llamacpp') { state.propsRequests++; return Response.json({ default_generation_settings: { n_ctx: state.window }, total_slots: state.slots, ...(state.vision !== undefined ? { modalities: { vision: state.vision } } : {}) }) }
    if (path === '/api/tags' && state.dialect === 'ollama') return Response.json({ models: [{ name: model }] })
    if (path === '/api/ps' && state.dialect === 'ollama') return Response.json({ models: [{ name: model, context_length: state.window }] })
    if (path === '/api/show' && state.dialect === 'ollama') return Response.json({ parameters: `num_ctx ${state.window}`, model_info: { 'fixture.context_length': 2_000_000 }, thinking: { values: state.thinkingValues, default: state.thinkingValues.at(-1) } })
    if (path !== '/v1/chat/completions') return new Response('not found', { status: 404 })
    const body = await req.json() as any
    captures.push({ path, body, auth: req.headers.get('authorization'), affinity: req.headers.get('x-session-id') })
    if (state.mode === 'reject-image' && JSON.stringify(body.messages).includes('image_url')) return Response.json({ error: { message: 'image input is not supported - hint: if this is unexpected, you may need to provide the mmproj', type: 'server_error' } }, { status: 400 })
    if (state.mode === 'reject-effort' && (body.reasoning_effort !== undefined || body.chat_template_kwargs?.reasoning_effort !== undefined)) return Response.json({ error: { message: 'Unsupported parameter: reasoning_effort', param: 'reasoning_effort' } }, { status: 400 })
    if (state.mode === 'reject-template' && body.chat_template_kwargs !== undefined) return Response.json({ error: { message: 'Unsupported parameter', param: 'chat_template_kwargs' } }, { status: 400 })
    if (state.mode === 'reject-persistent') return Response.json({ error: { message: 'Invalid parameter', param: 'reasoning_effort' } }, { status: 400 })
    if (state.mode === 'reject-other') return Response.json({ error: { message: 'Invalid parameter: messages' } }, { status: 400 })
    if (state.mode === 'refuse') return Response.json({ error: { message: 'fixture refused' } }, { status: 401 })
    if (state.mode === 'retry') { state.mode = 'reply'; return Response.json({ error: { message: 'fixture timeout' } }, { status: 408 }) }
    const chunk = (delta: unknown, finish: string | null = null, usage?: unknown) => `data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`
    const usage = { prompt_tokens: 20, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 10 } }
    const count = body.messages.filter((row: any) => row.role === 'tool').length
    const tools = state.mode === 'tools' && count < 2
    const payload = chunk({ reasoning_content: `reasoning-${count}` }) + (tools
      ? chunk({ tool_calls: [{ index: 0, id: `fixture-call-${count}`, type: 'function', function: { name: 'FixtureEcho', arguments: '{"text":"hello"}' } }] }) + chunk({}, 'tool_calls', usage)
      : chunk({ content: 'LLMHOST-READY' }) + (state.mode === 'truncated' ? '' : chunk({}, 'stop', usage)))
    return new Response(payload + (state.mode === 'truncated' ? '' : 'data: [DONE]\n\n'), { headers: { 'content-type': 'text/event-stream' } })
  } })
  const baseUrl = `http://127.0.0.1:${server.port}/v1`
  const { enableConfigs } = await import(`${root}/src/utils/config.ts`)
  enableConfigs()
  const tool = { name: 'FixtureEcho', description: async () => 'Echo fixture', prompt: async () => 'Echo fixture', inputSchema: z.object({ text: z.string() }), userFacingName: () => 'FixtureEcho', isEnabled: () => true, isConcurrencySafe: () => true, isReadOnly: () => true, isMcp: false, needsPermissions: () => false } as never
  const { routedCallModel } = await import(`${root}/src/services/providers/callModelRouter.ts`)
  const { createUserMessage } = await import(`${root}/src/utils/messages.ts`)
  const { asSystemPrompt } = await import(`${root}/src/utils/systemPromptType.ts`)
  async function run(id: string, messages: any[] = [createUserMessage({ content: 'hello fixture' })], signal = new AbortController().signal, effort: string | null = 'max'): Promise<any[]> {
    const out: any[] = []
    for await (const event of routedCallModel({ messages, tools: [tool], systemPrompt: asSystemPrompt(['Fixture system']), thinkingConfig: { type: 'enabled', budgetTokens: 1024 }, signal,
      options: { model: id, ...(effort !== null ? { effortValue: effort } : {}), querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => ({}), agents: [], hasAppendSystemPrompt: false, mcpTools: [] } } as never)) { events.push(event); if (event.type === 'assistant') out.push(event) }
    return out
  }
  return { root, home, baseUrl, model, key, state, captures, events, run, createUserMessage, close: () => { server.stop(true); rmSync(home, { recursive: true, force: true }) } }
}
