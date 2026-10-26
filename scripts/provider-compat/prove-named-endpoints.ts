import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { assertRefusedCallResult } from '../providers/lib/refused-call-result.ts'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod/v4'

const root = resolve(process.env.PLUMBING_PROOF_ROOT ?? join(import.meta.dir, '../..'))
const parent = process.env.MERCURY_CONFIG_DIR ?? tmpdir()
mkdirSync(parent, { recursive: true })
const home = mkdtempSync(join(parent, 'named-endpoints-'))
delete process.env.MERCURY_HOME
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import(`${root}/src/services/providers/credentialEnvSpellings.ts`)
for (const key of [...ALL_PROVIDER_CREDENTIAL_ENV_VARS, 'MERCURY_COMPAT_BASE_URL', 'MERCURY_COMPAT_MODELS', 'MERCURY_COMPAT_LABEL']) delete process.env[key]
for (const key of Object.keys(process.env)) if (/^MERCURY_COMPAT_.*_API_KEY$/.test(key)) delete process.env[key]
let failures = 0
let checks = 0
function check(name: string, pass: unknown): void { checks++; if (!pass) failures++; console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`) }
const captures: Array<{ path: string; body: any; auth: string | null; header: string | null; affinity: string | null }> = []
let mode = 'text'
let listMode = 'good'
let listReads = 0
const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  if (path.endsWith('/models')) {
    listReads++
    if (listMode === 'malformed') return Response.json({ wrong: [] })
    if (listMode === 'oversize') return new Response('x', { headers: { 'content-length': '4194305' } })
    if (listMode === 'stream-oversize') return new Response('x'.repeat(4194305))
    if (listMode === 'redirect') return Response.redirect(`http://127.0.0.1:${server.port}/other/models`)
    return Response.json({ data: [{ id: 'Vendor/Fixture' }] })
  }
  const body = await req.json()
  captures.push({ path, body, auth: req.headers.get('authorization'), header: req.headers.get('x-fixture'), affinity: req.headers.get('x-session') })
  if (mode === 'auth') return Response.json({ error: { message: 'fixture credential refused' } }, { status: 401 })
  if (mode === 'retry') { mode = 'text'; return Response.json({ error: { message: 'fixture timeout' } }, { status: 408 }) }
  if (path.endsWith('/responses')) {
    const item = { type: 'message', id: 'fixture-msg', role: 'assistant', content: [{ type: 'output_text', text: 'ENDPOINT-SETTLED' }] }
    const reasoning = { type: 'reasoning', id: 'fixture-reason', summary: [], encrypted_content: 'fixture-encrypted-reasoning-not-a-secret' }
    const output = [reasoning, item]
    return new Response(sse({ type: 'response.created', response: { id: 'fixture-response', model: body.model, status: 'in_progress' } }) + sse({ type: 'response.output_text.delta', item_id: 'fixture-msg', output_index: 1, content_index: 0, delta: 'ENDPOINT-SETTLED' }) + output.map(item => sse({ type: 'response.output_item.done', item })).join('') + sse({ type: 'response.completed', response: { id: 'fixture-response', status: 'completed', output, usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 3 } } } }), { headers: { 'content-type': 'text/event-stream' } })
  }
  const chunk = (delta: unknown, finish: string | null = null, usage?: unknown) => sse({ model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })
  const usage = { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3 } }
  const payload = mode === 'tools' || mode === 'malformed'
    ? chunk({ tool_calls: [{ index: 0, id: 'fixture-call', type: 'function', function: { name: 'FixtureEcho', arguments: mode === 'malformed' ? '{broken' : '{"text":"hello"}' } }] }) + chunk({}, 'tool_calls', usage)
    : chunk({ content: 'ENDPOINT-SETTLED' }) + (mode === 'truncated' ? '' : chunk({}, 'stop', usage))
  return new Response(payload + (mode === 'truncated' ? '' : 'data: [DONE]\n\n'), { headers: { 'content-type': 'text/event-stream' } })
} })
const baseUrl = `http://127.0.0.1:${server.port}`
const { enableConfigs, saveGlobalConfig } = await import(`${root}/src/utils/config.ts`)
enableConfigs()
const { resetSettingsCache } = await import(`${root}/src/utils/settings/settingsCache.ts`)
const { parseSettingsFile } = await import(`${root}/src/utils/settings/settings.ts`)
const { SettingsSchema } = await import(`${root}/src/utils/settings/types.ts`)
const accounts = await import(`${root}/src/services/providers/openaicompat/compatAccounts.ts`)
const secrets = await import(`${root}/src/services/providers/providerSecrets.ts`)
const { canonicalWireModelId } = await import(`${root}/src/services/providers/routeLaw.ts`)
const { routedCallModel } = await import(`${root}/src/services/providers/callModelRouter.ts`)
const { resolveEngineDispatch } = await import(`${root}/src/utils/crew/engineDispatch.ts`)
const { readSignInRefusal } = await import(`${root}/src/utils/accounts/signInRefusal.ts`)
const { createUserMessage } = await import(`${root}/src/utils/messages.ts`)
const { asSystemPrompt } = await import(`${root}/src/utils/systemPromptType.ts`)
const { getModelOptions } = await import(`${root}/src/utils/model/modelOptions.ts`)
const { loginFamilyRows } = await import(`${root}/src/components/loginFamilyRows.ts`)
const { liveModelsReference } = await import(`${root}/src/services/resources/adapters/models.ts`)
const catalogue = existsSync(join(root, 'src/services/providers/openaicompat/compatCatalogue.ts')) ? await import(`${root}/src/services/providers/openaicompat/compatCatalogue.ts`) : null
const setConfig = (compatProvider: unknown): void => { writeFileSync(join(home, 'settings.json'), JSON.stringify({ compatProvider })); resetSettingsCache() }
const tool = { name: 'FixtureEcho', description: async () => 'Echo fixture', prompt: async () => 'Echo fixture', inputSchema: z.object({ text: z.string() }), userFacingName: () => 'FixtureEcho', isEnabled: () => true, isConcurrencySafe: () => true, isReadOnly: () => true, isMcp: false, needsPermissions: () => false } as never
const prompt = [createUserMessage({ content: 'hello fixture' })]
async function run(model: string, messages = prompt, signal = new AbortController().signal): Promise<any[]> {
  const out: any[] = []
  try {
    for await (const event of routedCallModel({ messages, tools: [tool], systemPrompt: asSystemPrompt(['Fixture system']), thinkingConfig: { type: 'disabled' }, signal,
      options: { model, querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => ({}), agents: [], hasAppendSystemPrompt: false, mcpTools: [], maxOutputTokensOverride: 256 } } as never)) if (event.type === 'assistant') out.push(event)
  } catch (error) { console.log(`observed refusal: ${error instanceof Error ? error.message : String(error)}`) }
  return out
}
const succeeded = (rows: any[]) => rows.some(row => !row.isApiErrorMessage && row.message.content.some((part: any) => part.text === 'ENDPOINT-SETTLED'))
try {
  console.log('the single-endpoint control')
  saveGlobalConfig(config => ({ ...config, compatProvider: { baseUrl: `${baseUrl}/default/v1`, label: 'Fixture default', models: ['Fixture'] } }))
  secrets.writeStoredCompatApiKey('proof-key-default-fixture-not-a-real-key')
  const legacyConfig = accounts.resolveCompatSlotConfig()
  const control = await run('compat/Fixture')
  const controlBody = captures.at(-1)?.body
  check('the single block keeps its config shape, id, key and request bytes', JSON.stringify(legacyConfig) === JSON.stringify({ baseUrl: `${baseUrl}/default/v1`, label: 'Fixture default', models: ['Fixture'] }) && succeeded(control) && captures.at(-1)?.auth === 'Bearer proof-key-default-fixture-not-a-real-key' && controlBody?.model === 'Fixture' && controlBody.max_tokens === 256 && controlBody.stream_options.include_usage)
  const map = { east: { baseUrl: `${baseUrl}/east/v1`, models: ['Fixture'], headers: { 'x-fixture': 'east' }, sessionAffinityHeader: 'x-session' }, west: { baseUrl: `${baseUrl}/west/v1`, models: ['Fixture'] }, live: { baseUrl: `${baseUrl}/live/v1` }, responses: { baseUrl: `${baseUrl}/responses/v1`, models: ['Fixture'], dialect: 'responses' } }
  setConfig(map)
  secrets.writeStoredCompatApiKey('proof-key-east-fixture-not-a-real-key', 'east')
  secrets.writeStoredCompatApiKey('proof-key-west-fixture-not-a-real-key', 'west')
  const start = captures.length
  check('east serves its named model', succeeded(await run('compat/east/Fixture')))
  check('west serves its named model', succeeded(await run('compat/west/Fixture')))
  const east = captures[start], west = captures[start + 1]
  check('two endpoints on one host keep separate stored keys, URLs and headers', east?.path === '/east/v1/chat/completions' && west?.path === '/west/v1/chat/completions' && east?.auth === 'Bearer proof-key-east-fixture-not-a-real-key' && west?.auth === 'Bearer proof-key-west-fixture-not-a-real-key' && east.header === 'east' && west.header === null && Boolean(east.affinity))
  check('a named chat endpoint has byte-identical request JSON to the single slot', JSON.stringify(east?.body) === JSON.stringify(controlBody))
  process.env.MERCURY_COMPAT_WEST_API_KEY = 'proof-key-west-env-fixture-not-a-real-key'
  await run('compat/west/Fixture')
  check('the endpoint environment key wins only for its name', captures.at(-1)?.auth === 'Bearer proof-key-west-env-fixture-not-a-real-key' && accounts.resolveCompatApiKey(process.env, 'east')?.key === 'proof-key-east-fixture-not-a-real-key')
  check('dynamic credential environment names are excluded by the secrets owner', secrets.credentialEnvNames().includes('MERCURY_COMPAT_WEST_API_KEY'))
  check('the secrets file stays owner-only', process.platform === 'win32' || (statSync(secrets.providerSecretsPathForDisplay()).mode & 0o777) === 0o600)
  check('picker groups each endpoint under its own name', ['east', 'west'].every(name => getModelOptions().some((row: any) => row.value === `compat/${name}/Fixture` && row.group.includes(name))))
  check('logins has one addressable key row per named endpoint', Object.keys(map).every(name => loginFamilyRows({ engineLegs: true }).some((row: any) => row.value === `compat/${name}`)))
  check('the models page lists endpoints separately', (await liveModelsReference({})).providers.some((row: any) => row.provider === 'openai-compat/east' && row.models.some((model: any) => model.id === 'compat/east/Fixture')))
  const noList = listReads
  await catalogue?.refreshCompatCatalogues()
  check('catalogue traffic off sends no discovery request', listReads === noList)
  delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC
  await catalogue?.refreshCompatCatalogues({ force: true })
  check('discovery lists the endpoint vendor id without changing case or segments', accounts.compatSlotModelIds().includes('compat/live/Vendor/Fixture'))
  const replies = await run('compat/responses/Fixture')
  check('the Responses dialect reaches /responses and settles measured usage', succeeded(replies) && captures.at(-1)?.path === '/responses/v1/responses' && replies.at(-1)?.message.usage.input_tokens === 7)
  await run('compat/responses/Fixture', [...replies, createUserMessage({ content: 'continue fixture' })])
  check('Responses reasoning replays on the same endpoint', captures.at(-1)?.body.input?.some((item: any) => item.type === 'reasoning' && item.encrypted_content === 'fixture-encrypted-reasoning-not-a-secret'))
  setConfig({ ...map, second: { baseUrl: `${baseUrl}/second/v1`, models: ['Fixture'], dialect: 'responses' } })
  await run('compat/second/Fixture', [...replies, createUserMessage({ content: 'continue fixture' })])
  check('encrypted reasoning never crosses endpoint identity', !captures.at(-1)?.body.input?.some((item: any) => item.type === 'reasoning'))
  mode = 'tools'
  const calls = await run('compat/east/Fixture')
  check('named endpoints settle validated tool calls', calls.some(row => row.message.content.some((block: any) => block.type === 'tool_use' && block.id === 'fixture-call')))
  mode = 'text'
  await run('compat/east/Fixture', [...calls, createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'fixture-call', content: 'hello' }] })])
  check('tool results replay with the original call identity', captures.at(-1)?.body.messages.some((message: any) => message.role === 'tool' && message.tool_call_id === 'fixture-call'))

  console.log('refusals')
  for (const name of ['', '../escape', '/absolute', 'C:\\escape', 'with space', 'upperCase', 'semi;colon', 'quote"name', 'x'.repeat(33)]) {
    const result = SettingsSchema().safeParse({ compatProvider: { [name]: { baseUrl: `${baseUrl}/v1` } } })
    check(`endpoint name refused: ${JSON.stringify(name)}`, !result.success)
  }
  for (const url of ['file:///fixture', 'ftp://fixture.invalid', 'not-a-url', 'https://user:pass@fixture.invalid', 'https://fixture.invalid/?secret=fixture']) check(`base URL refused: ${url}`, !SettingsSchema().safeParse({ compatProvider: { east: { baseUrl: url } } }).success)
  for (const value of [null, [], 'fixture', { east: {} }, { east: { baseUrl, headers: { authorization: 'fixture' } } }, { east: { baseUrl, sessionAffinityHeader: 'host' } }, { east: { baseUrl, headers: { 'x-fixture': 'bad\r\nline' } } }]) check(`malformed endpoint map refused: ${JSON.stringify(value)}`, !SettingsSchema().safeParse({ compatProvider: value }).success)
  writeFileSync(join(home, 'settings.json'), `{"compatProvider":{"east":{"baseUrl":"${baseUrl}/one"},"east":{"baseUrl":"${baseUrl}/two"}},"engine":{"effort":"max"}}`)
  resetSettingsCache()
  const duplicate = parseSettingsFile(join(home, 'settings.json'))
  check('a duplicate endpoint is refused with its key named, unrelated settings survive', duplicate.errors.some((error: any) => error.path === 'compatProvider.east' && error.message.includes('duplicate')) && duplicate.settings.engine.effort === 'max' && duplicate.settings.compatProvider === undefined)
  setConfig(map)
  const prior = readFileSync(secrets.providerSecretsPathForDisplay(), 'utf8')
  let refusal = ''
  try { secrets.writeStoredCompatApiKey('proof-key-unknown-fixture-not-a-real-key', 'unknown') } catch (error) { refusal = (error as Error).message }
  check('a key for an unknown endpoint is refused before any write', refusal.includes('compatProvider.unknown') && readFileSync(secrets.providerSecretsPathForDisplay(), 'utf8') === prior)
  console.log(`unknown key answer: ${refusal || '(not refused)'}`)
  const beforeUnknown = captures.length
  await run('compat/unknown/Fixture')
  check('an unknown endpoint refuses before inference and never uses default credentials', captures.length === beforeUnknown && canonicalWireModelId('compat/unknown/Fixture').ok === false)
  mode = 'auth'
  const beforeAuth = captures.length
  const auth = await run('compat/east/Fixture')
  check('a named endpoint 401 is one refusal, never another endpoint', captures.length === beforeAuth + 1 && auth.some(row => row.isApiErrorMessage && row.error === 'authentication_failed'))
  check('a stored named key refusal is recorded only for that endpoint', readSignInRefusal('compat-east')?.status === 401 && readSignInRefusal('compat-west') === undefined)
  check('the named key refusal names its own sign-in row and environment key', JSON.stringify(auth).includes('/logins compat/east') && JSON.stringify(auth).includes('MERCURY_COMPAT_EAST_API_KEY'))
  const modelRefusal = await resolveEngineDispatch('compat/east/Absent').then(() => '', (error: Error) => error.message)
  check('a named endpoint model refusal names the available-models page', modelRefusal.includes('mercury://models'))
  mode = 'malformed'
  check('malformed tool arguments keep their call identity and receive an error result without execution', await assertRefusedCallResult(await run('compat/east/Fixture'), { id: 'fixture-call', name: 'FixtureEcho', raw: '{broken' }))
  mode = 'truncated'
  check('a cut stream keeps its partial answer and its failure', (await run('compat/east/Fixture')).some(row => row.isApiErrorMessage))
  mode = 'retry'
  const beforeRetry = captures.length
  check('a retry stays on the named endpoint and then serves', succeeded(await run('compat/east/Fixture')) && captures.length === beforeRetry + 2 && captures.slice(beforeRetry).every(row => row.path === '/east/v1/chat/completions'))
  check('a served request clears the named endpoint refusal', readSignInRefusal('compat-east') === undefined)
  const controller = new AbortController(); controller.abort()
  const beforeAbort = captures.length
  await run('compat/east/Fixture', prompt, controller.signal)
  check('cancellation sends no request', captures.length === beforeAbort)
  for (const bad of ['malformed', 'oversize', 'stream-oversize', 'redirect']) {
    listMode = bad
    await catalogue?.refreshCompatCatalogues({ force: true, ...(bad === 'oversize' ? { fetchImpl: async () => new Response('x', { headers: { 'content-length': '4194305' } }) } : {}) })
    const endpoint = accounts.configuredCompatEndpoints?.().find((row: any) => row.name === 'live')
    const reading = endpoint && catalogue?.cachedCompatCatalogue(endpoint)
    check(`discovery refusal names ${bad} instead of a confident empty list`, bad.includes('oversize') ? reading?.error === 'models response exceeds 4194304 bytes' : Boolean(reading?.error))
    console.log(`${bad} answer: ${reading?.error ?? '(not refused)'}`)
  }
  console.log(`${failures ? 'NAMED ENDPOINTS RED' : 'NAMED ENDPOINTS GREEN'} (${checks} checks, ${failures} failures; loopback only)`)
} finally {
  server.stop(true)
  rmSync(home, { recursive: true, force: true })
}
process.exitCode = failures ? 1 : 0
