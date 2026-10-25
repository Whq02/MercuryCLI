#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'moonshot-k3-1-efforts-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = home
for (const key of [
  'MERCURY_MODEL',
  'MERCURY_EFFORT_LEVEL',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'HF_TOKEN',
  'DEEPSEEK_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_CUSTOM_MODEL_OPTION',
  'MERCURY_COMPAT_BASE_URL',
  'MERCURY_LOCAL_BASE_URL',
  'MERCURY_CONSOLE_MODEL',
  'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC',
  'CI',
  'NODE_ENV',
]) {
  delete process.env[key]
}
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const base of [
  'ANTHROPIC_BASE_URL',
  'MERCURY_OPENAI_API_BASE',
  'MERCURY_OPENAI_CHATGPT_BASE',
  'MERCURY_OPENAI_AUTH_BASE',
  'MERCURY_OPENROUTER_API_BASE',
  'MERCURY_GEMINI_API_BASE',
  'MERCURY_DEEPSEEK_API_BASE',
  'MERCURY_HUGGINGFACE_HUB_BASE',
  'MERCURY_HUGGINGFACE_API_BASE',
  'MERCURY_ZAI_API_BASE',
  'MERCURY_MOONSHOT_OAUTH_BASE',
  'MERCURY_MOONSHOT_API_BASE',
]) {
  process.env[base] = 'http://127.0.0.1:1'
}
process.env.MERCURY_MOONSHOT_CODING_BASE = 'http://127.0.0.1:1/coding/v1'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail?: string): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const API_IDS = ['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed'] as const
const PLAN_IDS = ['k3.1-pro', 'k3.1-pro-highspeed'] as const
const K3_SERIES = ['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed', 'kimi-k3', 'k3.1-pro', 'k3.1-pro-highspeed', 'k3', 'k3-256k']
const DIAL = 'low,high,max'
const CODING_PLAN_LIST = { object: 'list', data: [
  { id: 'kimi-for-coding', object: 'model', created: 500, owned_by: 'moonshot', context_length: 1048576, display_name: 'Kimi for Coding' },
  { id: 'k3.1-pro-highspeed', object: 'model', created: 400, owned_by: 'moonshot', supports_reasoning: true },
  { id: 'k3.1-pro', object: 'model', created: 300, owned_by: 'moonshot', supports_reasoning: true },
  { id: 'k3-256k', object: 'model', created: 200, owned_by: 'moonshot' },
  { id: 'k3', object: 'model', created: 100, owned_by: 'moonshot' },
] }

const chatBodies: Array<Record<string, unknown>> = []
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const realFetch = globalThis.fetch
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const spelled = String(url instanceof Request ? url.url : url)
  if (spelled === 'http://127.0.0.1:1/coding/v1/models') return Response.json(CODING_PLAN_LIST)
  if (spelled === 'http://127.0.0.1:1/coding/v1/chat/completions') {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    chatBodies.push(body)
    const model = String(body.model ?? '')
    return new Response(
      sse({ id: 'chatcmpl-k31', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content: 'plan answer' } }] }) +
        sse({ id: 'chatcmpl-k31', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 3 } }) +
        'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }
  if (spelled.includes('/v1/models')) {
    return new Response(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'fixture: no list here' } }), { status: 404, headers: { 'content-type': 'application/json' } })
  }
  throw new Error(`unexpected request: ${spelled}`)
}) as typeof fetch

;(await import('../../src/utils/config.ts')).enableConfigs()
const pins = await import('../../src/services/providers/moonshot/kimiPins.ts')
const replay = await import('../../src/services/providers/openaicompat/kimiReplay.ts')
const wire = await import('../../src/services/providers/openaicompat/compatWire.ts')
const accounts = await import('../../src/services/providers/moonshot/moonshotAccounts.ts')
const catalogue = await import('../../src/services/providers/moonshot/moonshotCatalogue.ts')
const { moonshotCatalogueEntries } = await import('../../src/services/providers/moonshot/moonshotAdapter.ts')
const { getContextWindowForModel, effortVocabularyFor } = await import('../../src/utils/model/capabilities.ts')
const { resolveStampedEffortTruth } = await import('../../src/utils/effort.ts')
const { declaredRouteOf } = await import('../../src/services/providers/routeLaw.ts')
const { recordSignIn } = await import('../../src/utils/accounts/signInLedger.ts')
const { moonshotCallModel } = await import('../../src/services/providers/moonshot/moonshotCallModel.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

const vocabularyOf = (id: string): string => {
  const view = effortVocabularyFor(id)
  return view.kind === 'provider' ? view.vocabulary.join(',') : view.kind
}
const defaultOf = (id: string): string | undefined => {
  const view = effortVocabularyFor(id)
  return view.kind === 'provider' ? view.defaultEffort : undefined
}
const sent = (id: string, effortValue: string | undefined): unknown =>
  wire.buildMoonshotExtras({ wireModel: id, effortValue, thinkingEnabled: true, maxOutputTokensOverride: undefined }).reasoning_effort
const screenEqualsWire = (id: string): boolean => {
  const view = effortVocabularyFor(id)
  if (view.kind !== 'provider') return false
  const offered = view.vocabulary.every(word => sent(id, word) === word)
  const truth = (word: string) => resolveStampedEffortTruth(id, word as never)
  const stepped = ['medium', 'xhigh', 'minimal'].every(word => sent(id, word) === truth(word).wire)
  const selectable = truth('high').selectable.join(',') === view.vocabulary.filter(word => ['low', 'medium', 'high', 'xhigh', 'max'].includes(word)).join(',')
  return offered && stepped && selectable
}

section('§1 the K3.1 ids resolve from the dated pins: window, ceiling, dial, default, thinking rule')
{
  for (const id of API_IDS) {
    const pin = pins.kimiDisplayPin(id)
    check(`${id} is pinned with today's date and its source page`, pin !== undefined && pin.observedAt === '2026-10-25' && typeof pin.source === 'string' && pin.source.startsWith('https://platform.kimi.ai/'), JSON.stringify(pin))
    check(`${id}: 1,048,576-token window, output ceiling 1,048,576, dial low·high·max, default max, thinking always on`, pin?.contextWindow === 1_048_576 && pin?.outputMax === 1_048_576 && (pin?.efforts ?? []).join(',') === DIAL && pin?.defaultEffort === 'max' && pin?.thinking === 'always-on', JSON.stringify(pin))
  }
  for (const id of PLAN_IDS) {
    const pin = pins.kimiPlanPin(id)
    check(`${id} is a plan pin with today's date, the Kimi Code page, the 1,048,576 window, the dial and default high`, pin !== undefined && pin.observedAt === '2026-10-25' && pin.source?.startsWith('https://www.kimi.com/code/') === true && pin.contextWindow === 1_048_576 && (pin.efforts ?? []).join(',') === DIAL && pin.defaultEffort === 'high' && pin.thinking === 'always-on', JSON.stringify(pin))
  }
  check('the display names are the pins\', not mechanical titles', pins.kimiDisplayName('kimi-k3.1-pro') === 'Kimi K3.1 Pro' && pins.kimiDisplayName('kimi-k3.1-pro-highspeed') === 'Kimi K3.1 Pro Highspeed' && pins.kimiDisplayName('k3.1-pro') === 'K3.1 Pro' && pins.kimiShortName('kimi-k3.1-pro-highspeed') === 'K3.1 Pro Highspeed')
  check('the K3 series set carries every K3.1 spelling beside the K3 ones', K3_SERIES.every(id => pins.KIMI_K3_MODELS.has(id)), [...pins.KIMI_K3_MODELS].join(','))
  check('the effort set is the set of pins stating a dial — the K3 series and nothing else', [...pins.KIMI_EFFORT_MODELS].toSorted().join(',') === [...K3_SERIES].toSorted().join(','), [...pins.KIMI_EFFORT_MODELS].join(','))
  check('the effort vocabulary stays low·high·max', [...pins.KIMI_EFFORTS].join(',') === DIAL)
  check('kimiAcceptsEffort reads the pinned dial for every K3.1 spelling', K3_SERIES.every(id => pins.kimiAcceptsEffort(id, 'low') && pins.kimiAcceptsEffort(id, 'max') && !pins.kimiAcceptsEffort(id, 'medium')))
  check('a Kimi id with no dial accepts nothing', !pins.kimiAcceptsEffort('kimi-k2.7-code', 'high') && pins.kimiEffortsFor('kimi-k2.6').length === 0 && pins.kimiDefaultEffort('kimi-k2.5') === undefined)
  check('preserved thinking derives from the thinking rule: the K3 series and the K2.7 Code rows, never K2.6', K3_SERIES.every(id => pins.KIMI_PRESERVED_THINKING_MODELS.has(id)) && pins.KIMI_PRESERVED_THINKING_MODELS.has('kimi-k2.7-code') && pins.KIMI_PRESERVED_THINKING_MODELS.has('kimi-k2.7-code-highspeed') && !pins.KIMI_PRESERVED_THINKING_MODELS.has('kimi-k2.6'), [...pins.KIMI_PRESERVED_THINKING_MODELS].join(','))
  check('the K3.1 ids load tools dynamically like K3', K3_SERIES.every(id => pins.KIMI_DYNAMIC_TOOL_MODELS.has(id)))
  check('the replay law reads the K3.1 ids and the OpenRouter slug as K3 wire models', K3_SERIES.every(id => replay.isKimiK3WireModel(id)) && replay.isKimiK3WireModel('moonshotai/kimi-k3.1-pro') && !replay.isKimiK3WireModel('kimi-k2.6'))
}

section('§2 the API-key road: what the screen offers is what the wire sends')
{
  for (const id of API_IDS) {
    check(`${id}: the capability edge offers the pinned dial with default max`, vocabularyOf(id) === DIAL && defaultOf(id) === 'max', `${vocabularyOf(id)} default=${String(defaultOf(id))}`)
    check(`${id}: every offered word rides as reasoning_effort, a word outside the dial steps to the nearest rung the record names, and the selectable rungs are the dial`, screenEqualsWire(id), JSON.stringify({ high: sent(id, 'high'), medium: sent(id, 'medium'), record: resolveStampedEffortTruth(id, 'medium' as never) }))
    check(`${id}: nothing asked sends no effort key (the provider default governs)`, sent(id, undefined) === undefined)
    check(`${id}: the context budget is the pinned window`, getContextWindowForModel(id) === 1_048_576, String(getContextWindowForModel(id)))
  }
  check('kimi-k3 keeps its dial and gains its default', vocabularyOf('kimi-k3') === DIAL && defaultOf('kimi-k3') === 'max' && sent('kimi-k3', 'high') === 'high')
  check('kimi-k2.7-code and kimi-k2.6 offer no dial and the wire sends none', vocabularyOf('kimi-k2.7-code') === 'none' && vocabularyOf('kimi-k2.6') === 'none' && sent('kimi-k2.7-code', 'high') === undefined)
  const entries = moonshotCatalogueEntries()
  const entry = (id: string) => entries.find(row => row.id === id)
  check('signed out, the adapter catalogue lists the K3.1 rows from the pins with the same dial the edge offers', API_IDS.every(id => entry(id)?.efforts.join(',') === vocabularyOf(id) && entry(id)?.contextWindow === 1_048_576 && entry(id)?.displayLabel === pins.kimiDisplayName(id)), JSON.stringify(entries.map(row => [row.id, row.efforts])))
  check('kimi-k3 stays the head of the pin table', entries[0]?.id === 'kimi-k3' && entries[1]?.id === 'kimi-k3.1-pro' && entries[2]?.id === 'kimi-k3.1-pro-highspeed', entries.map(row => row.id).join(','))
}

section('§3 the Kimi sign-in road: the plan ids route by the live list and carry the dial, the window and the wire word')
{
  accounts.writeMoonshotTokens({ accessToken: 'fixture-access-plan', refreshToken: 'fixture-refresh-plan', accessTokenExpiresAtMs: Date.now() + 86400000 }, 'global')
  recordSignIn('moonshot', 'oauth')
  catalogue.__resetMoonshotCatalogueForTest()
  await catalogue.refreshMoonshotCatalogue({ force: true })
  const live = catalogue.moonshotCatalogueRows()
  check('the plan list lands live newest first, the K3.1 highspeed row grouped under its base, no pinned head', live.source.kind === 'live' && live.rows.map(row => row.id).join(',') === 'kimi-for-coding,k3.1-pro,k3.1-pro-highspeed,k3,k3-256k', live.rows.map(row => row.id).join(','))
  check('the K3.1 plan rows paint their pinned names and the 1,048,576 window the list does not state', live.rows.find(row => row.id === 'k3.1-pro')?.displayName === 'K3.1 Pro' && live.rows.find(row => row.id === 'k3.1-pro')?.contextWindow === 1_048_576 && live.rows.find(row => row.id === 'k3.1-pro-highspeed')?.displayName === 'K3.1 Pro Highspeed' && live.rows.find(row => row.id === 'k3.1-pro-highspeed')?.contextWindow === 1_048_576, JSON.stringify(live.rows.map(row => [row.id, row.displayName, row.contextWindow])))
  for (const id of PLAN_IDS) {
    check(`${id} routes to Moonshot by the live list and offers the dial with default high`, declaredRouteOf(id) === 'moonshot' && vocabularyOf(id) === DIAL && defaultOf(id) === 'high', `${String(declaredRouteOf(id))} ${vocabularyOf(id)} default=${String(defaultOf(id))}`)
    check(`${id}: screen equals wire, and the context budget is 1,048,576`, screenEqualsWire(id) && getContextWindowForModel(id) === 1_048_576)
  }
  check('kimi-for-coding on the same list offers no dial', vocabularyOf('kimi-for-coding') === 'none' && sent('kimi-for-coding', 'high') === undefined)
  const entries = moonshotCatalogueEntries()
  check('the adapter catalogue carries the live rows with the dial the edge offers', PLAN_IDS.every(id => entries.find(row => row.id === id)?.efforts.join(',') === DIAL) && entries.find(row => row.id === 'kimi-for-coding')?.efforts.length === 0, JSON.stringify(entries.map(row => [row.id, row.efforts])))
  const typed = await catalogue.qualifyMoonshotModel('kimi-k3.1-pro')
  check('a typed kimi-k3.1-pro on the plan account qualifies to k3.1-pro', typed.kind === 'ok' && typed.modelId === 'k3.1-pro', JSON.stringify(typed))
  const params = (model: string, effortValue: string): Parameters<typeof moonshotCallModel>[0] => ({
    messages: [createUserMessage({ content: 'say hi' })],
    systemPrompt: ['fixture system prompt'],
    thinkingConfig: { type: 'enabled', budget_tokens: 1024 },
    tools: [],
    signal: new AbortController().signal,
    options: { getToolPermissionContext: async () => getEmptyToolPermissionContext(), model, isNonInteractiveSession: true, querySource: 'agent:builtin:test', agents: [], hasAppendSystemPrompt: false, mcpTools: [], effortValue },
  }) as never
  for (const [model, asked, expected] of [['k3.1-pro', 'max', 'max'], ['k3.1-pro-highspeed', 'medium', 'low']] as const) {
    chatBodies.length = 0
    let apiError = false
    for await (const item of moonshotCallModel(params(model, asked))) {
      if ((item as { type?: string }).type === 'assistant' && (item as { isApiErrorMessage?: boolean }).isApiErrorMessage === true) apiError = true
    }
    check(`a ${model} turn asked ${asked} puts reasoning_effort ${expected} on the wire with model ${model}, no temperature, and settles clean`, chatBodies.length === 1 && chatBodies[0]?.model === model && chatBodies[0]?.reasoning_effort === expected && !('temperature' in (chatBodies[0] ?? {})) && !apiError, JSON.stringify(chatBodies[0]))
  }
  accounts.writeMoonshotTokens(null)
  catalogue.__resetMoonshotCatalogueForTest()
}

globalThis.fetch = realFetch
rmSync(scratch, { recursive: true, force: true })
console.log(`\nprove-moonshot-k3-1-efforts: ${checks} checks, ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
