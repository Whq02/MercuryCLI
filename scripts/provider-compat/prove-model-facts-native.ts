import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod/v4'

const root = resolve(process.env.PLUMBING_PROOF_ROOT ?? join(import.meta.dir, '../..'))
const parent = process.env.MERCURY_CONFIG_DIR ?? tmpdir()
mkdirSync(parent, { recursive: true })
const home = mkdtempSync(join(parent, 'model-facts-native-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
delete process.env.MERCURY_AUTH_SCOPE_DIR
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import(`${root}/src/services/providers/credentialEnvSpellings.ts`)
for (const key of ALL_PROVIDER_CREDENTIAL_ENV_VARS) delete process.env[key]
const captures: any[] = []
const sse = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  if (new URL(request.url).pathname !== '/responses') return Response.json({ error: 'unexpected fixture route' }, { status: 400 })
  const body = await request.json()
  captures.push(body)
  const item = { type: 'message', id: 'facts-response', role: 'assistant', content: [{ type: 'output_text', text: 'NATIVE-FACTS-SETTLED' }] }
  return new Response(sse({ type: 'response.created', response: { id: 'facts-native', model: body.model, status: 'in_progress' } }) + sse({ type: 'response.output_text.delta', item_id: 'facts-response', output_index: 0, content_index: 0, delta: 'NATIVE-FACTS-SETTLED' }) + sse({ type: 'response.output_item.done', item }) + sse({ type: 'response.completed', response: { id: 'facts-native', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 3 } } } }), { headers: { 'content-type': 'text/event-stream' } })
} })
const origin = `http://127.0.0.1:${server.port}`
process.env.MERCURY_OPENAI_API_BASE = origin
process.env.OPENAI_API_KEY = 'proof-key-native-facts-not-a-real-key'
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
const catalogue = await import(`${root}/src/services/providers/openai/openaiCatalogue.ts`)
const { getContextWindowForModel, modelReceivesImageBlocks } = await import(`${root}/src/utils/model/capabilities.ts`)
const set = (models: unknown) => { writeFileSync(join(home, 'settings.json'), JSON.stringify({ models })); resetSettingsCache() }
const tool = { name: 'FixtureEcho', description: async () => 'Echo fixture', prompt: async () => 'Echo fixture', inputSchema: z.object({ text: z.string() }), userFacingName: () => 'FixtureEcho', isEnabled: () => true, isConcurrencySafe: () => true, isReadOnly: () => true, isMcp: false, needsPermissions: () => false } as never
const fresh = 'gpt-9.9'
const known = 'gpt-6-astra'
const live = { id: fresh, supportedReasoningEfforts: [], reasoningEffortsStated: false, contextWindow: 800_000, inputModalities: ['text'] }
const prompt = [createUserMessage({ content: 'native model facts fixture' })]
async function run(model: string, messages = prompt): Promise<any[]> {
  const out: any[] = []
  for await (const row of routedCallModel({ messages, tools: [tool], systemPrompt: asSystemPrompt(['Native model facts fixture']), thinkingConfig: { type: 'adaptive' }, signal: new AbortController().signal,
    options: { model, effortValue: 'max', querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => ({}), agents: [], hasAppendSystemPrompt: false, mcpTools: [] } } as never)) if (row.type === 'assistant') out.push(row)
  return out
}
let checks = 0
let failures = 0
const check = (name: string, pass: unknown) => { checks++; if (!pass) failures++; console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`) }
const served = (rows: any[]) => rows.some(row => !row.isApiErrorMessage && row.message.content.some((block: any) => block.text === 'NATIVE-FACTS-SETTLED'))
try {
  set({})
  catalogue.primeOpenaiCatalogue({ sourceKind: 'api-key', models: [live, { id: known, supportedReasoningEfforts: ['low', 'high', 'max'], reasoningEffortsStated: true, contextWindow: 800_000, inputModalities: ['text', 'image'] }], fetchedAtMs: Date.now() })
  check('the live unknown native model serves before metadata is added', served(await run(fresh)))
  const plain = JSON.stringify(captures.at(-1))
  await run(known)
  const control = JSON.stringify(captures.at(-1))
  set({ [fresh]: { contextWindow: 1_500_000, maxOutputTokens: 240_000, efforts: ['low', 'max'], images: true, reasoning: true } })
  check('an explicit native metadata entry still serves on its own provider', served(await run(fresh)))
  check('the native Responses request uses the stated max effort', captures.at(-1)?.reasoning?.effort === 'max')
  check('the API-key request uses the stated output ceiling whole', captures.at(-1)?.max_output_tokens === 240_000)
  check('native tools remain present with metadata', captures.at(-1)?.tools?.some((entry: any) => entry.name === 'FixtureEcho'))
  const candidate = catalogue.evaluateGptCandidate(fresh, 'api-key')
  check('the native candidate uses the stated effort and image facts', candidate.ok && candidate.candidate.live.supportedReasoningEfforts.includes('max') && candidate.candidate.live.inputModalities?.includes('image'))
  const image = createUserMessage({ content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1sAAAAASUVORK5CYII=' } }, { type: 'text', text: 'native fixture image' }] })
  await run(fresh, [image])
  check('stated native image support reaches the actual Responses input', captures.at(-1)?.input.some((item: any) => Array.isArray(item.content) && item.content.some((part: any) => part.type === 'input_image')))
  await run(known)
  check('a different native model retains byte-identical request JSON', JSON.stringify(captures.at(-1)) === control)

  console.log('refusals')
  set({ [known]: { efforts: ['low'], images: false, reasoning: false } })
  const reduced = catalogue.evaluateGptCandidate(known, 'api-key')
  check('smaller metadata keeps the native live effort and image capabilities', reduced.ok && reduced.candidate.live.supportedReasoningEfforts.includes('max') && reduced.candidate.live.inputModalities?.includes('image'))
  set({ _default: { openai: { contextWindow: 1_500_000, efforts: ['max'], images: true } } })
  const defaulted = catalogue.evaluateGptCandidate(fresh, 'api-key')
  check('a family default fills the native vocabulary missing from a live unknown row', defaulted.ok && defaulted.candidate.live.supportedReasoningEfforts.includes('max'))
  check('a family default does not overwrite a native live window or media statement', getContextWindowForModel(fresh) === 800_000 && !modelReceivesImageBlocks(fresh) && defaulted.ok && !defaulted.candidate.live.inputModalities?.includes('image'))
  set({ 'gpt-9.8': { contextWindow: 1_500_000, efforts: ['max'] } })
  const beforeAbsent = captures.length
  const absent = await run('gpt-9.8')
  check('metadata cannot add a model absent from the native account catalogue', captures.length === beforeAbsent && absent.some(row => row.isApiErrorMessage))
  set({})
  await run(fresh)
  check('clearing native metadata restores the original request bytes', JSON.stringify(captures.at(-1)) === plain)
  console.log(`${failures ? 'NATIVE MODEL FACTS RED' : 'NATIVE MODEL FACTS GREEN'} (${checks} checks, ${failures} failures; loopback only)`)
} finally {
  globalThis.fetch = nativeFetch
  server.stop(true)
  rmSync(home, { recursive: true, force: true })
}
process.exit(failures ? 1 : 0)
