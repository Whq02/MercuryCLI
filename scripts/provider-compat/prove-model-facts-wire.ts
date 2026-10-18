import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod/v4'

const root = resolve(process.env.PLUMBING_PROOF_ROOT ?? join(import.meta.dir, '../..'))
const parent = process.env.MERCURY_CONFIG_DIR ?? tmpdir()
mkdirSync(parent, { recursive: true })
const home = mkdtempSync(join(parent, 'model-facts-wire-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import(`${root}/src/services/providers/credentialEnvSpellings.ts`)
for (const key of ALL_PROVIDER_CREDENTIAL_ENV_VARS) delete process.env[key]
for (const key of Object.keys(process.env)) if (/^MERCURY_COMPAT_/.test(key)) delete process.env[key]
const captures: Array<{ path: string; body: any }> = []
let mode = 'text'
const sse = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname
  const body = await request.json()
  captures.push({ path, body })
  if (mode === 'refused') return Response.json({ error: { message: 'fixture key rejected' } }, { status: 401 })
  const usage = { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3 } }
  const delta = mode === 'tools'
    ? { tool_calls: [{ index: 0, id: 'facts-call', type: 'function', function: { name: 'FixtureEcho', arguments: '{"text":"facts"}' } }] }
    : { content: 'MODEL-FACTS-SETTLED' }
  return new Response(sse({ model: body.model, choices: [{ index: 0, delta, finish_reason: null }] }) + sse({ model: body.model, choices: [{ index: 0, delta: {}, finish_reason: mode === 'tools' ? 'tool_calls' : 'stop' }], usage }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
} })
const origin = `http://127.0.0.1:${server.port}`
process.env.MERCURY_COMPAT_BASE_URL = `${origin}/compat`
process.env.MERCURY_COMPAT_MODELS = 'Fixture'
process.env.MERCURY_DEEPSEEK_API_BASE = `${origin}/deepseek`
process.env.DEEPSEEK_API_KEY = 'proof-key-facts-not-a-real-key'
const nativeFetch = globalThis.fetch
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.origin !== origin) throw new Error(`non-loopback proof request refused: ${url.origin}`)
  return nativeFetch(input, init)
}) as typeof fetch
const { enableConfigs } = await import(`${root}/src/utils/config.ts`)
enableConfigs()
const { resetSettingsCache } = await import(`${root}/src/utils/settings/settingsCache.ts`)
const { routedCallModel } = await import(`${root}/src/services/providers/callModelRouter.ts`)
const { createUserMessage } = await import(`${root}/src/utils/messages.ts`)
const { asSystemPrompt } = await import(`${root}/src/utils/systemPromptType.ts`)
const { getModelOptions } = await import(`${root}/src/utils/model/modelOptions.ts`)
const { liveModelsReference } = await import(`${root}/src/services/resources/adapters/models.ts`)
const { getUsageForModel } = await import(`${root}/src/cost-tracker.ts`)
const { getModelMaxOutputTokens } = await import(`${root}/src/utils/model/capabilities.ts`)
const set = (models: unknown) => { writeFileSync(join(home, 'settings.json'), JSON.stringify({ models })); resetSettingsCache() }
const tool = { name: 'FixtureEcho', description: async () => 'Echo fixture', prompt: async () => 'Echo fixture', inputSchema: z.object({ text: z.string() }), userFacingName: () => 'FixtureEcho', isEnabled: () => true, isConcurrencySafe: () => true, isReadOnly: () => true, isMcp: false, needsPermissions: () => false } as never
const prompt = [createUserMessage({ content: 'fixture model facts' })]
async function run(model: string, messages = prompt, signal = new AbortController().signal): Promise<any[]> {
  const out: any[] = []
  for await (const row of routedCallModel({ messages, tools: [tool], systemPrompt: asSystemPrompt(['Fixture model facts']), thinkingConfig: { type: 'adaptive' }, signal,
    options: { model, effortValue: 'max', querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => ({}), agents: [], hasAppendSystemPrompt: false, mcpTools: [] } } as never)) if (row.type === 'assistant') out.push(row)
  return out
}
const settled = (rows: any[]) => rows.some(row => !row.isApiErrorMessage && row.message.content.some((block: any) => block.text === 'MODEL-FACTS-SETTLED'))
let checks = 0
let failures = 0
function check(name: string, pass: unknown) { checks++; if (!pass) failures++; console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`) }
try {
  set({})
  check('the ordinary endpoint serves without metadata', settled(await run('compat/Fixture')))
  const ordinary = JSON.stringify(captures.at(-1)?.body)
  check('the native-family control serves without metadata', settled(await run('deepseek-v4-pro')))
  const nativeControl = JSON.stringify(captures.at(-1)?.body)
  set({ 'compat/Fixture': { contextWindow: 1_500_000, maxOutputTokens: 240_000, efforts: ['low', 'max'], reasoning: true, images: true, prices: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 3 } } })
  const costBefore = getUsageForModel('compat/Fixture')?.costUSD ?? 0
  check('the metadata-bearing endpoint still serves normally', settled(await run('compat/Fixture')))
  const stated = captures.at(-1)?.body
  check('the full stated output ceiling reaches the request', stated?.max_tokens === 240_000)
  check('the stated max effort reaches the request unchanged', stated?.reasoning_effort === 'max')
  check('all tool declarations remain available with metadata', stated?.tools?.some((entry: any) => entry.function.name === 'FixtureEcho'))
  const ledger = getUsageForModel('compat/Fixture')
  check('settled usage is priced at the operator rates', Math.abs((ledger?.costUSD ?? 0) - costBefore - 0.0000315) < 1e-12)
  check('the usage ledger records the stated window and output ceiling', ledger?.contextWindow === 1_500_000 && ledger?.maxOutputTokens === 240_000)
  const picker = getModelOptions().find((row: any) => row.value === 'compat/Fixture')
  check('the picker reads the stated context window', picker?.statedContextWindow === 1_500_000)
  const page = await liveModelsReference({})
  const pageRow = page.providers.flatMap((provider: any) => provider.models).find((row: any) => row.id === 'compat/Fixture')
  check('the models page reads the same stated window and efforts', pageRow?.contextWindow === 1_500_000 && pageRow?.efforts?.includes('max'))
  const image = createUserMessage({ content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1sAAAAASUVORK5CYII=' } }, { type: 'text', text: 'fixture image' }] })
  await run('compat/Fixture', [image])
  check('stated image support delivers the actual image part', captures.at(-1)?.body.messages.some((message: any) => Array.isArray(message.content) && message.content.some((part: any) => part.type === 'image_url')))
  await run('deepseek-v4-pro')
  check('an unrelated family keeps byte-identical request JSON', JSON.stringify(captures.at(-1)?.body) === nativeControl)
  mode = 'tools'
  const calls = await run('compat/Fixture')
  check('metadata leaves validated tool calls executable', calls.some(row => row.message.content.some((block: any) => block.type === 'tool_use' && block.id === 'facts-call')))
  mode = 'text'
  await run('compat/Fixture', [...calls, createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'facts-call', content: 'facts' }] })])
  check('tool continuation preserves its identity and metadata settings', captures.at(-1)?.body.messages.some((message: any) => message.tool_call_id === 'facts-call') && captures.at(-1)?.body.max_tokens === 240_000 && captures.at(-1)?.body.reasoning_effort === 'max')

  console.log('refusals')
  const pinnedOutput = getModelMaxOutputTokens('deepseek-v4-pro').upperLimit
  set({ 'deepseek-v4-pro': { contextWindow: 1, maxOutputTokens: 1, efforts: ['low'], reasoning: false, images: false } })
  await run('deepseek-v4-pro')
  check('a smaller metadata ceiling never lowers the native model request', captures.at(-1)?.body.max_tokens >= pinnedOutput)
  check('a reduced effort entry never remaps native max on the request', captures.at(-1)?.body.reasoning_effort === 'max')
  mode = 'refused'
  const beforeRefusal = captures.length
  const refusal = await run('deepseek-v4-pro')
  check('metadata never hides a real credential refusal or changes provider', captures.length === beforeRefusal + 1 && captures.at(-1)?.path === '/deepseek/chat/completions' && refusal.some(row => row.isApiErrorMessage && row.error === 'authentication_failed'))
  mode = 'text'
  const controller = new AbortController(); controller.abort()
  const beforeCancel = captures.length
  await run('compat/Fixture', prompt, controller.signal)
  check('a cancelled metadata turn sends no request', captures.length === beforeCancel)
  set({})
  await run('compat/Fixture')
  check('removing metadata restores the ordinary request bytes', JSON.stringify(captures.at(-1)?.body) === ordinary)
  console.log(`${failures ? 'MODEL FACTS WIRE RED' : 'MODEL FACTS WIRE GREEN'} (${checks} checks, ${failures} failures; loopback only)`)
} finally {
  globalThis.fetch = nativeFetch
  server.stop(true)
  rmSync(home, { recursive: true, force: true })
}
process.exit(failures ? 1 : 0)
