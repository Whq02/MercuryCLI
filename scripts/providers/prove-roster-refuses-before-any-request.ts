#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'roster-door-'))
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = HOME
for (const key of ['MERCURY_MODEL', 'MERCURY_DEFAULT_FABLE_MODEL', 'MERCURY_DEFAULT_OPUS_MODEL', 'MERCURY_DEFAULT_SONNET_MODEL', 'MERCURY_DEFAULT_HAIKU_MODEL', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_WORKER_PARENT_PID']) delete process.env[key]
delete process.env.NODE_ENV
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' a model outside the roster is refused before any request')
console.log('============================================================')

let requests = 0
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch() {
    requests++
    return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'the fixture answers nothing' } }), { status: 400, headers: { 'content-type': 'application/json' } })
  },
})
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const allow = await import('../../src/utils/model/modelAllowlist.ts')
const model = await import('../../src/utils/model/model.ts')
const router = await import('../../src/services/providers/callModelRouter.ts')
const headless = await import('../../src/cli/headless/model.ts')
const { resetComputedDefaultMemo } = await import('../../src/utils/model/computedDefault.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { recordSignIn } = await import('../../src/utils/accounts/signInLedger.ts')
recordSignIn('anthropic', 'api-key')

const OPUS = 'claude-opus-5-5'
const FABLE_51 = 'claude-fable-5-1'
const sentence = (id: string): string => `'${id}' is outside this organization's engine.roster. Refused before any request — the /model picker lists the models the roster permits.`
const refusalOf = (id: string): string | null => {
  const read = (allow as { rosterRefusal?: (model: string) => string | null }).rosterRefusal
  return typeof read === 'function' ? read(id) : '(modelAllowlist exports no rosterRefusal)'
}
function settings(engine: Record<string, unknown>, envModel?: string): void {
  writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ engine }))
  if (envModel !== undefined) process.env.MERCURY_MODEL = envModel
  else delete process.env.MERCURY_MODEL
  resetSettingsCache()
  resetComputedDefaultMemo()
}
async function dispatched(id: string): Promise<{ rows: Array<{ error: boolean; text: string; code: string }>; requests: number; threw: string }> {
  const before = requests
  const rows: Array<{ error: boolean; text: string; code: string }> = []
  let threw = ''
  const permissionContext = getEmptyToolPermissionContext()
  try {
    for await (const item of router.routedCallModel({
      messages: [createUserMessage({ content: 'Say hello.' })] as never,
      systemPrompt: ['You are a fixture assistant.'] as never,
      thinkingConfig: { type: 'disabled' } as never,
      tools: [],
      signal: AbortSignal.timeout(20_000),
      options: { getToolPermissionContext: async () => permissionContext, model: id, isNonInteractiveSession: true, querySource: 'main_thread', agents: [], hasAppendSystemPrompt: false, mcpTools: [], maxRetries: 0 } as never,
    })) {
      const row = item as { type?: string; isApiErrorMessage?: boolean; error?: string; message?: { content?: Array<{ text?: string }> } }
      if (row.type === 'assistant') rows.push({ error: row.isApiErrorMessage === true, text: row.message?.content?.[0]?.text ?? '', code: row.error ?? '' })
    }
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  return { rows, requests: requests - before, threw }
}

section('§1 the one reader: a roster, a model it excludes, the sentence')
{
  settings({})
  check('no roster: nothing is refused', [OPUS, 'gpt-5.5', 'deepseek-v4-pro', 'house-model-7'].every(id => refusalOf(id) === null), [OPUS, 'gpt-5.5'].map(id => String(refusalOf(id))).join(' | '))
  settings({ roster: [FABLE_51] })
  check('a model the roster permits is not refused, with or without its window rider', refusalOf(FABLE_51) === null && refusalOf(`${FABLE_51}[1m]`) === null, `${refusalOf(FABLE_51)} | ${refusalOf(`${FABLE_51}[1m]`)}`)
  check("a model it excludes: the id, the roster's own name, that nothing was sent, where the permitted models are listed", refusalOf(OPUS) === sentence(OPUS), String(refusalOf(OPUS)))
  check("another vendor's model outside the roster reads the same sentence", refusalOf('gpt-5.5') === sentence('gpt-5.5'), String(refusalOf('gpt-5.5')))
  settings({ roster: [] })
  check('an empty roster permits nothing', refusalOf(FABLE_51) === sentence(FABLE_51), String(refusalOf(FABLE_51)))
  settings({ roster: [FABLE_51], disabledProviders: ['openai'] })
  check("a disabled provider's model keeps the disabled road's own words: the roster's sentence does not speak for it", refusalOf('gpt-5.5') === null && !allow.isModelAllowed('gpt-5.5'), String(refusalOf('gpt-5.5')))
}

section('§2 the two doors of the router read it: the boot refusal and the dispatch')
{
  settings({ roster: [FABLE_51] })
  const boot = await router.modelRefusalBeforeAnyRequest(OPUS)
  check('modelRefusalBeforeAnyRequest answers the sentence for the excluded model', boot === sentence(OPUS), String(boot))
  check('…and nothing for the permitted one', (await router.modelRefusalBeforeAnyRequest(FABLE_51)) === null, String(await router.modelRefusalBeforeAnyRequest(FABLE_51)))
  const call = await dispatched(OPUS)
  check('the dispatch yields one row and it is the refusal, as an API error row', call.rows.length === 1 && call.rows[0]!.error && call.rows[0]!.text === `API Error: ${sentence(OPUS)}` && call.rows[0]!.code === 'invalid_request' && call.threw === '', JSON.stringify(call))
  check('no request left for the provider', call.requests === 0, String(call.requests))
  settings({})
  check('with no roster the boot door refuses nothing for that model', (await router.modelRefusalBeforeAnyRequest(OPUS)) === null, String(await router.modelRefusalBeforeAnyRequest(OPUS)))
  const open = await dispatched(OPUS)
  check('…and the dispatch reaches the provider (the fixture answers 400; the row is the provider\'s, not the roster\'s)', open.requests >= 1 && open.rows.every(row => !row.text.includes('engine.roster')), JSON.stringify(open))
}

section('§3 every road that names an excluded model meets the door')
{
  let thrown = ''
  settings({ roster: [FABLE_51] })
  try {
    await headless.resolveHeadlessModel(OPUS)
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error)
  }
  check('--model <an excluded id>: the headless boot refuses with the sentence', thrown === sentence(OPUS), thrown)
  check('--model fable resolves inside the roster and is not refused', (await headless.resolveHeadlessModel('fable')) === FABLE_51)
  settings({ roster: [FABLE_51], model: OPUS })
  check('a saved excluded id is the session model, unchanged, and the door refuses it', model.getEngineModel() === OPUS && refusalOf(model.getEngineModel()) === sentence(OPUS), `${model.getEngineModel()} | ${refusalOf(model.getEngineModel())}`)
  settings({ roster: [FABLE_51] }, OPUS)
  check('MERCURY_MODEL=<an excluded id>: the same', model.getEngineModel() === OPUS && refusalOf(model.getEngineModel()) === sentence(OPUS), `${model.getEngineModel()} | ${refusalOf(model.getEngineModel())}`)
  process.env.MERCURY_DEFAULT_FABLE_MODEL = 'claude-fable-5-2'
  try {
    settings({ roster: [FABLE_51], model: 'fable' })
    check('a family word pinned to an excluded id is refused by the id the pin names', model.getEngineModel() === 'claude-fable-5-2' && refusalOf(model.getEngineModel()) === sentence('claude-fable-5-2'), `${model.getEngineModel()} | ${refusalOf(model.getEngineModel())}`)
  } finally {
    delete process.env.MERCURY_DEFAULT_FABLE_MODEL
  }
  settings({ roster: [FABLE_51] })
  check('nothing saved under that roster is the permitted default and meets no refusal', model.getEngineModel() === FABLE_51 && refusalOf(model.getEngineModel()) === null, `${model.getEngineModel()} | ${refusalOf(model.getEngineModel())}`)
}

settings({})
await server.stop(true)
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`}`)
process.exit(failures === 0 ? 0 : 1)
