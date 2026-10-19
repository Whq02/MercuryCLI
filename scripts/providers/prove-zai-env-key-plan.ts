#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { readFileSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { proofHome } from '../lib/hermetic.ts'
import type { Message } from '../../src/types/message.ts'
import type { CompatCallModelParams } from '../../src/services/providers/openaicompat/compatChatCallModel.ts'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)
process.env.MERCURY_HOME = proofHome
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS = '5000'
const GENERAL_BASE = 'https://zai.fixture.invalid/general/v4'
const CODING_BASE = 'https://zai.fixture.invalid/coding/v4'
process.env.MERCURY_ZAI_API_BASE = GENERAL_BASE
process.env.MERCURY_ZAI_CODING_API_BASE = CODING_BASE
for (const key of ['ZAI_API_KEY', 'ZAI_KEY_PLAN', 'MERCURY_MODEL', 'MERCURY_EFFORT_LEVEL', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC', 'MERCURY_MAX_RETRIES', 'NODE_ENV']) delete process.env[key]

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { writeStoredZaiApiKey } = await import('../../src/services/providers/providerSecrets.ts')
const accounts = await import('../../src/services/providers/zai/zaiAccounts.ts')
const discovery = await import('../../src/services/providers/providerDiscovery.ts')
const { zaiApiBase } = await import('../../src/services/providers/zai/zaiClient.ts')
const cat = await import('../../src/services/providers/zai/zaiCatalogue.ts')
const { zaiCallModel } = await import('../../src/services/providers/zai/zaiCallModel.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { readSignInRefusal } = await import('../../src/utils/accounts/signInRefusal.ts')
const keyPlan = await import('../../src/services/providers/zai/zaiKeyPlan.ts').catch(() => null)

let failures = 0
let count = 0
const check = (name: string, ok: unknown, detail = ''): void => {
  count++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${!ok && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const j = (v: unknown): string => JSON.stringify(v)
const CODING_KEY = 'zai-fixture-env-coding-plan-key'
const GENERAL_KEY = 'zai-fixture-env-general-key'
const STORED_KEY = 'zai-fixture-stored-coding-key'

type Road = { url: string; method: string; key: string | null; body: Record<string, unknown> }
const roads: Road[] = []
const trail = (from = 0): string => roads.slice(from).map(road => `${road.method} ${road.url.replace('https://zai.fixture.invalid/', '')}${road.key === `Bearer ${CODING_KEY}` ? '' : ` [${road.key}]`}`).join(' → ')
const sseChunk = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
const chatChunks = (text: string): string[] => [
  sseChunk({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'glm-5.3-flash', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }] }),
  sseChunk({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'glm-5.3-flash', choices: [], usage: { prompt_tokens: 19, completion_tokens: 3, total_tokens: 22 } }),
  'data: [DONE]\n\n',
]
const refusal = (): Response => Response.json({ error: { code: '1002', message: 'Authentication failed: the key is not valid on this base' } }, { status: 401 })
const listing = (): Response => Response.json({ data: [{ id: 'glm-5.3-flash', owned_by: 'z.ai', created: 1_759_000_000 }, { id: 'glm-5.3', owned_by: 'z.ai', created: 1_759_000_001 }] })
type Fixture = { generalList: (key: string) => Response; codingList: (key: string) => Response; generalChat: (key: string) => Response; codingChat: (key: string) => Response }
const codingKeyWorld: Fixture = {
  generalList: () => refusal(),
  codingList: key => (key === CODING_KEY ? listing() : refusal()),
  generalChat: () => refusal(),
  codingChat: key => (key === CODING_KEY ? sseResponse(chatChunks('served on the coding base')) : refusal()),
}
let fixture: Fixture = codingKeyWorld
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input)
  const key = (new Headers(init?.headers).get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
  roads.push({ url, method: init?.method ?? 'GET', key: new Headers(init?.headers).get('authorization'), body })
  const coding = url.startsWith(CODING_BASE)
  const general = url.startsWith(GENERAL_BASE)
  if (url.endsWith('/models') && general) return fixture.generalList(key)
  if (url.endsWith('/models') && coding) return fixture.codingList(key)
  if (url.endsWith('/chat/completions') && general) return fixture.generalChat(key)
  if (url.endsWith('/chat/completions') && coding) return fixture.codingChat(key)
  return Response.json({ error: 'unexpected fixture url' }, { status: 404 })
}) as typeof fetch

const user = (content: string): Message => ({ type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content } }) as Message
function params(): CompatCallModelParams {
  return {
    messages: [user('Reply with the single word OK.')],
    systemPrompt: asSystemPrompt(['Only answer the request.']),
    thinkingConfig: { type: 'disabled' } as never,
    tools: [],
    signal: new AbortController().signal,
    options: { model: 'glm-5.3-flash', querySource: 'agent:builtin:mercury-crew', agentId: 'a-zai-plan-fixture', onWait: () => {}, isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [] } as never,
  }
}
type Driven = { from: number; items: unknown[]; text: string; apiError: string | undefined }
async function drive(): Promise<Driven> {
  const from = roads.length
  const items: unknown[] = []
  for await (const item of zaiCallModel(params() as never)) items.push(item)
  const assistants = items.filter(item => (item as { type?: string }).type === 'assistant') as Array<{ isApiErrorMessage?: boolean; message: { content: Array<{ type: string; text?: string }> } }>
  const text = assistants.filter(row => row.isApiErrorMessage !== true).flatMap(row => row.message.content).filter(block => block.type === 'text').map(block => block.text ?? '').join('')
  const apiError = assistants.find(row => row.isApiErrorMessage === true)?.message.content.map(block => block.text ?? '').join('')
  return { from, items, text, apiError }
}
function freshProcessState(): void {
  keyPlan?.forgetZaiKeyPlans()
  cat.__resetZaiCatalogueForTest()
  delete process.env.ZAI_KEY_PLAN
  delete process.env.ZAI_API_KEY
}
const codingSeamFile = readFileSync(join(ROOT, 'src/services/providers/zai/zaiClient.ts'), 'utf8').includes('MERCURY_ZAI_CODING_API_BASE')

try {
  section('§1 the dispatch record of a plan-less key: ZAI_KEY_PLAN, else learned, never assumed silently')
  const env = { ZAI_API_KEY: CODING_KEY }
  const planless = accounts.resolveZaiDispatch(env)
  check('an env key with no plan word is a dispatch whose plan is marked assumed (the general base stands in until the service answers)', planless?.source === 'env' && planless.plan === 'general' && (planless as { planSource?: string }).planSource === 'assumed', j(planless))
  const twin = discovery.resolveZaiDispatch(env)
  check('the providerDiscovery twin says the same', twin?.source === 'env' && (twin as { planSource?: string }).planSource === 'assumed', j(twin))
  const explicit = accounts.resolveZaiDispatch({ ...env, ZAI_KEY_PLAN: 'coding' })
  check('ZAI_KEY_PLAN=coding names the Coding Plan for an env key', explicit?.plan === 'coding' && (explicit as { planSource?: string }).planSource === 'env' && discovery.resolveZaiDispatch({ ...env, ZAI_KEY_PLAN: 'coding' })?.plan === 'coding', j(explicit))
  check('ZAI_KEY_PLAN=General (any case) names the general plan', accounts.resolveZaiDispatch({ ...env, ZAI_KEY_PLAN: 'General' })?.plan === 'general' && (accounts.resolveZaiDispatch({ ...env, ZAI_KEY_PLAN: 'General' }) as { planSource?: string })?.planSource === 'env')
  const unknownWord = keyPlan?.zaiKeyPlanUnknownWord({ ZAI_KEY_PLAN: 'premium' })
  check('a plan word Mercury does not know is named with the two it knows', unknownWord === 'ZAI_KEY_PLAN=premium is not a plan Mercury knows — coding (a GLM Coding Plan key) or general; unset it and the plan is read from the key\'s own models list' && keyPlan?.zaiKeyPlanUnknownWord({ ZAI_KEY_PLAN: 'coding' }) === undefined && keyPlan?.zaiKeyPlanUnknownWord({}) === undefined, String(unknownWord))
  writeStoredZaiApiKey(STORED_KEY, 'coding')
  const stored = accounts.resolveZaiDispatch({ ZAI_KEY_PLAN: 'general' })
  check('a stored key keeps the plan it was proven under; ZAI_KEY_PLAN describes a plan-less key only', stored?.source === 'stored' && stored.plan === 'coding' && (stored as { planSource?: string }).planSource === 'stored', j(stored))
  check('the coding seam pins the Coding Plan base alone; without it the one seam still pins both plans', zaiApiBase({ MERCURY_ZAI_API_BASE: 'http://127.0.0.1:1/v4' }, 'coding') === 'http://127.0.0.1:1/v4' && zaiApiBase({ MERCURY_ZAI_API_BASE: 'http://127.0.0.1:1/v4', MERCURY_ZAI_CODING_API_BASE: 'http://127.0.0.1:1/coding' }, 'coding') === 'http://127.0.0.1:1/coding' && zaiApiBase({ MERCURY_ZAI_API_BASE: 'http://127.0.0.1:1/v4', MERCURY_ZAI_CODING_API_BASE: 'http://127.0.0.1:1/coding' }, 'general') === 'http://127.0.0.1:1/v4' && zaiApiBase({}, 'coding') === 'https://api.z.ai/api/coding/paas/v4', `coding seam in zaiClient: ${codingSeamFile}`)

  section('§2 the catalogue learns the plan of an env key from the models list: the general base first, then the Coding Plan base')
  freshProcessState()
  process.env.ZAI_API_KEY = CODING_KEY
  let from = roads.length
  const snapshot = await cat.refreshZaiCatalogue({ force: true })
  check('a GLM Coding Plan key: refused on the general list, listed on the Coding Plan list — two reads under the bearer key', trail(from) === 'GET general/v4/models → GET coding/v4/models', trail(from))
  check('the snapshot is the Coding Plan list under the env key', snapshot?.keySource === 'env' && snapshot.plan === 'coding' && snapshot.models.length === 2 && snapshot.lastError === undefined, j(snapshot))
  const learnedDispatch = accounts.resolveZaiDispatch()
  check('the dispatch now carries the learned plan', learnedDispatch?.plan === 'coding' && (learnedDispatch as { planSource?: string }).planSource === 'learned', j(learnedDispatch))
  check('the cached catalogue is found under the learned identity', cat.getCachedZaiCatalogue()?.plan === 'coding' && cat.zaiCatalogueRows().source.kind === 'live', j(cat.getCachedZaiCatalogue()))
  from = roads.length
  await cat.refreshZaiCatalogue({})
  check('inside the TTL nothing is sent', roads.length === from, trail(from))
  freshProcessState()
  process.env.ZAI_API_KEY = GENERAL_KEY
  fixture = { ...codingKeyWorld, generalList: key => (key === GENERAL_KEY ? listing() : refusal()) }
  from = roads.length
  const general = await cat.refreshZaiCatalogue({ force: true })
  check('a general key is listed on the general base with one read and learned as general', trail(from) === `GET general/v4/models [Bearer ${GENERAL_KEY}]` && general?.plan === 'general' && (accounts.resolveZaiDispatch() as { planSource?: string })?.planSource === 'learned', `${trail(from)} ${j(general)}`)
  freshProcessState()
  process.env.ZAI_API_KEY = 'zai-fixture-key-nobody-minted'
  fixture = codingKeyWorld
  from = roads.length
  const refusedBoth = await cat.refreshZaiCatalogue({ force: true })
  check('a key refused on both lists: the error names both bases, the plan stays unlearned, the key never rides the words', trail(from) === 'GET general/v4/models [Bearer zai-fixture-key-nobody-minted] → GET coding/v4/models [Bearer zai-fixture-key-nobody-minted]' && refusedBoth?.lastError === 'Z.AI models endpoint refused the credential (HTTP 401) on the general base and on the Coding Plan base — Authentication failed: the key is not valid on this base' && refusedBoth.models.length === 0 && (accounts.resolveZaiDispatch() as { planSource?: string })?.planSource === 'assumed' && !j(refusedBoth).includes('nobody-minted'), `${trail(from)} ${j(refusedBoth)}`)
  freshProcessState()
  process.env.ZAI_API_KEY = CODING_KEY
  fixture = { ...codingKeyWorld, generalList: () => Response.json({ error: { code: '500', message: 'fixture outage' } }, { status: 500 }) }
  from = roads.length
  const outage = await cat.refreshZaiCatalogue({ force: true })
  check('an outage on the general list is reported in the same words as before and asks no second base', trail(from) === 'GET general/v4/models' && outage?.lastError === 'Z.AI models endpoint returned HTTP 500 — fixture outage' && (accounts.resolveZaiDispatch() as { planSource?: string })?.planSource === 'assumed', `${trail(from)} ${j(outage)}`)

  section('§3 the wire: a GLM Coding Plan key given as ZAI_API_KEY reaches the Coding Plan base (the field row M39-01)')
  freshProcessState()
  process.env.ZAI_API_KEY = CODING_KEY
  fixture = codingKeyWorld
  const first = await drive()
  check('the first turn reads the plan from the models list, then posts to the Coding Plan base', trail(first.from) === 'GET general/v4/models → GET coding/v4/models → POST coding/v4/chat/completions', trail(first.from))
  check('the turn settles with the words the Coding Plan base served — no api error', first.text === 'served on the coding base' && first.apiError === undefined, j({ text: first.text, apiError: first.apiError }))
  check("the base build's words never appear: nothing says the key is refused on the general base", first.apiError === undefined || !first.apiError.includes('refused on the general base'), String(first.apiError))
  const second = await drive()
  check('the second turn remembers the plan: one post to the Coding Plan base, no list read', trail(second.from) === 'POST coding/v4/chat/completions' && second.text === 'served on the coding base', trail(second.from))
  check('no refusal record was written for the family', readSignInRefusal('zai') === undefined, j(readSignInRefusal('zai')))

  freshProcessState()
  process.env.ZAI_API_KEY = CODING_KEY
  process.env.ZAI_KEY_PLAN = 'coding'
  const stated = await drive()
  check('with ZAI_KEY_PLAN=coding nothing is probed: one post straight to the Coding Plan base', trail(stated.from) === 'POST coding/v4/chat/completions' && stated.text === 'served on the coding base', trail(stated.from))

  freshProcessState()
  process.env.ZAI_API_KEY = CODING_KEY
  fixture = { ...codingKeyWorld, generalList: () => listing() }
  const corrected = await drive()
  check('a general list that answers every key is corrected by the chat itself: refused on general, served on the Coding Plan base, once', trail(corrected.from) === 'GET general/v4/models → POST general/v4/chat/completions → POST coding/v4/chat/completions' && corrected.text === 'served on the coding base' && corrected.apiError === undefined, `${trail(corrected.from)} ${j({ text: corrected.text, apiError: corrected.apiError })}`)
  check('the correction is remembered and left no refusal record', readSignInRefusal('zai') === undefined && (accounts.resolveZaiDispatch() as { planSource?: string })?.planSource === 'learned' && accounts.resolveZaiDispatch()?.plan === 'coding', j(accounts.resolveZaiDispatch()))
  const afterCorrection = await drive()
  check('the next turn posts to the Coding Plan base directly', trail(afterCorrection.from) === 'POST coding/v4/chat/completions', trail(afterCorrection.from))

  freshProcessState()
  process.env.ZAI_API_KEY = 'zai-fixture-key-nobody-minted'
  fixture = codingKeyWorld
  const nobody = await drive()
  check('a key no base accepts: both lists, then both chat bases are asked once, and the fault is reported', trail(nobody.from) === 'GET general/v4/models [Bearer zai-fixture-key-nobody-minted] → GET coding/v4/models [Bearer zai-fixture-key-nobody-minted] → POST general/v4/chat/completions [Bearer zai-fixture-key-nobody-minted] → POST coding/v4/chat/completions [Bearer zai-fixture-key-nobody-minted]' && nobody.text === '' && nobody.apiError !== undefined, trail(nobody.from))
  check('the fault names the plan word and the service words, never the old general-base clause', nobody.apiError !== undefined && nobody.apiError.includes('zai-1002') && nobody.apiError.includes('ZAI_KEY_PLAN=coding names a GLM Coding Plan key') && !nobody.apiError.includes('refused on the general base') && !nobody.apiError.includes('nobody-minted'), String(nobody.apiError))

  freshProcessState()
  process.env.ZAI_API_KEY = CODING_KEY
  process.env.ZAI_KEY_PLAN = 'premium'
  const premium = await drive()
  check('ZAI_KEY_PLAN=premium is refused before any request, naming the two plan words', trail(premium.from) === '' && premium.apiError !== undefined && premium.apiError.includes('ZAI_KEY_PLAN=premium is not a plan Mercury knows — coding (a GLM Coding Plan key) or general'), `${trail(premium.from)} ${String(premium.apiError)}`)

  freshProcessState()
  fixture = { ...codingKeyWorld, codingChat: key => (key === STORED_KEY ? sseResponse(chatChunks('served on the coding base')) : refusal()) }
  const storedTurn = await drive()
  check('the stored road is untouched: a stored GLM Coding Plan key posts to the Coding Plan base with no list read', trail(storedTurn.from) === `POST coding/v4/chat/completions [Bearer ${STORED_KEY}]` && storedTurn.text === 'served on the coding base', trail(storedTurn.from))
  check('no request body carried a key', roads.every(road => !j(road.body).includes('zai-fixture')))

  section('§4 the words')
  const login = readFileSync(join(ROOT, 'src/services/providers/zai/zaiLogin.ts'), 'utf8')
  check('the /logins receipt no longer says an env key rides the general base', !login.includes('using the general base') && login.includes('its plan is ZAI_KEY_PLAN, or read from its own models list'))
  const engines = readFileSync(join(ROOT, 'docs/ENGINES.md'), 'utf8')
  check('ENGINES.md names ZAI_KEY_PLAN and the learned plan of an env key', engines.includes('`ZAI_KEY_PLAN`') && engines.includes('reads the plan from the key\'s own models list'))

  console.log('')
  if (failures > 0) {
    console.log(`ZAI ENV KEY PLAN RED (${failures} of ${count} checks failing)`)
    process.exit(1)
  }
  console.log(`ZAI ENV KEY PLAN GREEN (${count} checks; fixture only)`)
} finally {
  rmSync(proofHome, { recursive: true, force: true })
}
