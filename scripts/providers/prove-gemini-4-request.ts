#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_RECOVERY_BUDGET_MINUTES = '1'
process.env.MERCURY_GEMINI_API_BASE = 'https://gemini.fixture.invalid/v1beta'
process.env.MERCURY_GEMINI_OAUTH_TOKEN_BASE = 'https://gemini.fixture.invalid/token'
process.env.MERCURY_ANTIGRAVITY_CODE_ASSIST_BASE = 'https://assist.fixture.invalid'
process.env.MERCURY_ANTIGRAVITY_MANIFEST_BASE = 'https://manifest.fixture.invalid'
for (const name of ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MERCURY_GEMINI_OAUTH_CLIENT_ID', 'MERCURY_GEMINI_OAUTH_CLIENT_SECRET', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC', 'MERCURY_EFFORT_LEVEL']) delete process.env[name]
const key = 'AIzaFixtureGeminiFourRequest000000000000'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { geminiCallModel, __resetGeminiPlanWireForTest } = await import('../../src/services/providers/gemini/geminiCallModel.ts')
const catalogue = await import('../../src/services/providers/gemini/geminiCatalogue.ts')
const capabilities = await import('../../src/utils/model/capabilities.ts')
const effort = await import('../../src/utils/effort.ts')
const { geminiPlanQuotaView } = await import('../../src/services/providers/gemini/geminiPlanQuota.ts')
const { resolveDisplayedSessionModel } = await import('../../src/hooks/useDisplayedSessionModel.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
import type { AssistantMessage, Message } from '../../src/types/message.ts'
import type { CompatCallModelParams } from '../../src/services/providers/openaicompat/compatChatCallModel.ts'

let passes = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) passes++
  else failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const j = (value: unknown): string => JSON.stringify(value)

type Road = 'api-key' | 'plan'
const WINDOW = 1_048_576
const ROSTER_CEILING = 262_144
const live = (id: string, thinking = true) => ({ name: `models/${id}`, displayName: id, inputTokenLimit: WINDOW, outputTokenLimit: 65_536, supportedGenerationMethods: ['generateContent', 'countTokens'], thinking })
const LIVE_LIST = [live('gemini-4-hydrogen'), live('gemini-4-carbon'), live('gemini-4-argon'), live('gemini-3.8-flash'), live('gemini-2.5-pro')]
const row = (displayName: string, maxOutputTokens: number) => ({ displayName, supportsThinking: true, supportsImages: true, maxTokens: WINDOW, maxOutputTokens })
const ROSTER: Record<string, unknown> = {
  'gemini-4-hydrogen-low': row('Gemini 4 Hydrogen (Low)', ROSTER_CEILING),
  'gemini-4-hydrogen-medium': row('Gemini 4 Hydrogen (Medium)', ROSTER_CEILING),
  'gemini-4-hydrogen-high': row('Gemini 4 Hydrogen (High)', ROSTER_CEILING),
  'gemini-4-hydrogen-xhigh': row('Gemini 4 Hydrogen (XHigh)', ROSTER_CEILING),
  'gemini-4-carbon-low': row('Gemini 4 Carbon (Low)', ROSTER_CEILING),
  'gemini-4-carbon-medium': row('Gemini 4 Carbon (Medium)', ROSTER_CEILING),
  'gemini-4-carbon-high': row('Gemini 4 Carbon (High)', ROSTER_CEILING),
  'gemini-4-argon-low': row('Gemini 4 Argon (Low)', ROSTER_CEILING),
  'gemini-4-argon-medium': row('Gemini 4 Argon (Medium)', ROSTER_CEILING),
  'gemini-4-argon-high': row('Gemini 4 Argon (High)', ROSTER_CEILING),
  'gemini-3.8-flash-low': row('Gemini 3.8 Flash (Low)', 65_536),
  'gemini-3.8-flash-medium': row('Gemini 3.8 Flash (Medium)', 65_536),
  'gemini-3.8-flash-high': row('Gemini 3.8 Flash (High)', 65_536),
  'gemini-3-flash': row('Gemini 3 Flash', 65_536),
}

type Hit = { url: string; body: Record<string, any> }
const hits: Hit[] = []
type Step = unknown[] | ((request: Record<string, any>) => unknown[])
let script: Step[] = []
const sse = (chunks: unknown[], plan: boolean): Response => new Response(chunks.map(chunk => `data: ${JSON.stringify(plan ? { response: chunk } : chunk)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
const plainAnswer = [{ candidates: [{ content: { role: 'model', parts: [{ text: 'ok', thoughtSignature: 'sig-answer' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 2 } }]
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input)
  if (!/^https:\/\/(?:gemini|assist|manifest)\.fixture\.invalid\//.test(url)) throw new Error(`unpinned request ${url}`)
  if (url.endsWith('/token')) return Response.json({ access_token: 'ya29.plan-fixture', expires_in: 3600 })
  if (url.includes('/models?')) return Response.json({ models: LIVE_LIST })
  if (url.endsWith('/v1internal:fetchAvailableModels')) return Response.json({ models: ROSTER, imageGenerationModelIds: [], agentModelSorts: [] })
  if (url.startsWith('https://manifest.fixture.invalid/')) return new Response('version: 2.31.2\n')
  const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>
  hits.push({ url, body })
  const plan = url.includes('/v1internal:')
  const step = script.shift() ?? plainAnswer
  return sse(typeof step === 'function' ? step((body.request ?? body) as Record<string, any>) : step, plan)
}) as typeof fetch

async function useRoad(road: Road): Promise<void> {
  if (road === 'api-key') {
    process.env.GEMINI_API_KEY = key
    writeFileSync(join(proofHome, '.gemini-auth.json'), JSON.stringify({ version: 1, preferredSource: 'api-key' }))
  } else {
    delete process.env.GEMINI_API_KEY
    writeFileSync(join(proofHome, '.gemini-auth.json'), JSON.stringify({ version: 1, preferredSource: 'plan', plan: { tokens: { accessToken: 'ya29.plan-fixture', refreshToken: '1//refresh-fixture', accessTokenExpiresAtMs: Date.now() + 3_600_000 }, projectId: 'project-fixture-123', tier: { paid: { id: 'g1-ultra-tier', name: 'Google AI Ultra' } }, tierReadAtMs: Date.now() } }))
  }
  catalogue.__resetGeminiCatalogueForTest()
  __resetGeminiPlanWireForTest()
  await catalogue.refreshGeminiCatalogue(road, { force: true })
}

const tool = (name: string, key: string) => ({ name, prompt: async () => `${name} tool.`, inputSchema: z.object({ [key]: z.string() }), inputJSONSchema: { type: 'object', properties: { [key]: { type: 'string' } }, required: [key] } })
const tools = [tool('Bash', 'command'), tool('Read', 'file_path')]
const user = (content: unknown): Message => ({ type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content } }) as Message
type Ask = { effort?: string; thinking?: boolean; withTools?: boolean; maxOutput?: number }
function params(model: string, messages: Message[], ask: Ask = {}): CompatCallModelParams {
  return {
    messages, systemPrompt: asSystemPrompt(['Only answer the request.']), thinkingConfig: ask.thinking === false ? { type: 'disabled' } : { type: 'adaptive' }, tools: ask.withTools ? tools as never : [], signal: new AbortController().signal,
    options: { model, querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], ...(ask.effort !== undefined ? { effortValue: ask.effort } : {}), ...(ask.maxOutput !== undefined ? { maxOutputTokensOverride: ask.maxOutput } : {}) } as never,
  } as CompatCallModelParams
}
async function drain(input: CompatCallModelParams): Promise<AssistantMessage[]> {
  const out: AssistantMessage[] = []
  for await (const item of geminiCallModel(input)) if (item.type === 'assistant') out.push(item)
  return out
}
type Sent = { wireModel: string | undefined; request: Record<string, any>; generationConfig: Record<string, any> | undefined; answer: AssistantMessage[] }
async function send(model: string, messages: Message[], ask: Ask = {}): Promise<Sent> {
  hits.length = 0
  const answer = await drain(params(model, messages, ask))
  const body = hits.at(-1)?.body ?? {}
  const request = (body.request ?? body) as Record<string, any>
  sentLog.push({ model: (body.model as string | undefined) ?? model, request })
  return { wireModel: body.model as string | undefined, request, generationConfig: request.generationConfig as Record<string, any> | undefined, answer }
}
const sentLog: Array<{ model: string; request: Record<string, any> }> = []
const levelOf = (sent: Sent): string => j(sent.generationConfig?.thinkingConfig)
const level = (word: string): string => j({ thinkingLevel: word })
const stampOf = (sent: Sent): { asked?: string; applied?: string; wire?: string } => (sent.answer.at(-1) as { effort?: { asked?: string; applied?: string; wire?: string } } | undefined)?.effort ?? {}
const listWords = (model: string): string => `efforts ${effort.selectableEffortLevels(model).join(' · ')}`
async function sweep(model: string): Promise<Record<string, Sent>> {
  const out: Record<string, Sent> = {}
  for (const word of ['none', 'low', 'medium', 'high', 'xhigh', 'max']) out[word] = await plain(model, word === 'none' ? {} : { effort: word })
  return out
}
const ROOT = join(import.meta.dir, '..', '..')
const SEGMENT = 65_536
const cutAfterThinking: Step = request => [{ candidates: [{ content: { role: 'model', parts: [{ text: '', thoughtSignature: 'sig-cut' }] }, finishReason: Number(request.generationConfig?.maxOutputTokens ?? SEGMENT) > SEGMENT ? 'CONTINUATION' : 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 60, candidatesTokenCount: 0, thoughtsTokenCount: SEGMENT } }]
const { query } = await import('../../src/query.ts')
const { productionDeps } = await import('../../src/query/deps.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
;(await import('../../src/bootstrap/state.ts')).setIsInteractive(false)
type Turn = { notices: string[]; answers: string[]; terminal: string; requests: Array<Record<string, any>> }
async function runTurn(model: string, prompt: string, steps: Step[]): Promise<Turn> {
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
  const ctx = {
    abortController: new AbortController(),
    options: { commands: [], tools: [], engineModel: model, thinkingConfig: { type: 'adaptive' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
    getAppState: () => appState,
    setAppState: (f: (prev: never) => never): void => { appState = f(appState as never) as unknown as Record<string, unknown> },
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId: undefined,
  }
  hits.length = 0
  script = [...steps]
  const yields: Array<Record<string, any>> = []
  const gen = query({ messages: [createUserMessage({ content: prompt })] as never, systemPrompt: ['be brief'] as never, userContext: {}, systemContext: {}, canUseTool: (async () => ({ behavior: 'deny', message: 'no tools in this rig' })) as never, toolUseContext: ctx as never, querySource: 'sdk' as never, deps: productionDeps() })
  let step = await gen.next()
  while (!step.done) {
    yields.push(step.value as Record<string, any>)
    step = await gen.next()
  }
  script = []
  const textOf = (row: Record<string, any>): string => (Array.isArray(row.message?.content) ? row.message.content.filter((block: { type?: string }) => block.type === 'text').map((block: { text?: string }) => String(block.text ?? '')).join('') : '')
  return {
    notices: yields.filter(row => row.type === 'system' && typeof row.content === 'string').map(row => String(row.content)),
    answers: yields.filter(row => row.type === 'assistant' && row.isApiErrorMessage !== true).map(textOf).filter(text => text !== ''),
    terminal: String((step.value as { reason?: string } | undefined)?.reason ?? ''),
    requests: hits.map(hit => (hit.body.request ?? hit.body) as Record<string, any>),
  }
}
const plain = (model: string, ask: Ask = {}): Promise<Sent> => send(model, [user('Say hello.')], ask)
const vocabularyOf = (model: string): readonly string[] => {
  const view = capabilities.effortVocabularyFor(model)
  return 'vocabulary' in view ? view.vocabulary : []
}

try {
  console.log('── the Google sign-in: a bare Gemini 4 id reads the window, the output ceiling and the efforts of the row it rides ──')
  await useRoad('plan')
  for (const bare of ['gemini-4-hydrogen', 'gemini-4-carbon', 'gemini-4-argon']) {
    const high = `${bare}-high`
    check(`${bare}: the window is the ${high} row's 1,048,576, not the 200,000 of an id no list names`, capabilities.getContextWindowForModel(bare) === WINDOW && capabilities.getContextWindowForModel(high) === WINDOW, `${capabilities.getContextWindowForModel(bare)}`)
    check(`${bare}: the output ceiling is that row's`, catalogue.geminiOutputTokenLimitFor(bare) === catalogue.geminiOutputTokenLimitFor(high) && catalogue.geminiOutputTokenLimitFor(bare) !== undefined, `${catalogue.geminiOutputTokenLimitFor(bare)} ${catalogue.geminiOutputTokenLimitFor(high)}`)
    check(`${bare}: the effort dial exists, as on the row it rides`, vocabularyOf(bare).length > 0 && ['low', 'medium', 'high'].every(word => vocabularyOf(bare).includes(word)), j(capabilities.effortVocabularyFor(bare)))
  }
  const bareTurn = await plain('gemini-4-hydrogen', { effort: 'high' })
  check('a turn on the bare gemini-4-hydrogen rides gemini-4-hydrogen-high and its output room is measured against 1,048,576 (read live on the build before this: 190,682 asked, 200,000 less the prompt)', bareTurn.wireModel === 'gemini-4-hydrogen-high' && bareTurn.generationConfig?.maxOutputTokens === (await plain('gemini-4-hydrogen-high', { effort: 'high' })).generationConfig?.maxOutputTokens, j(bareTurn.generationConfig))
  check('a Gemini 3.x bare id whose roster names only effort rows keeps what it had: the conservative 200,000', capabilities.getContextWindowForModel('gemini-3.8-flash') === 200_000 && capabilities.getContextWindowForModel('gemini-3.8-flash-high') === WINDOW, `${capabilities.getContextWindowForModel('gemini-3.8-flash')}`)
  check('a row the roster names keeps its own facts, and an id no roster row leads to keeps the fallback', capabilities.getContextWindowForModel('gemini-3-flash') === WINDOW && capabilities.getContextWindowForModel('gemini-4-neon') === 200_000 && vocabularyOf('gemini-4-neon').length === 0)
  await useRoad('api-key')
  check('with an API key the bare id is the listed id and nothing is borrowed from a row', capabilities.getContextWindowForModel('gemini-4-hydrogen') === WINDOW && capabilities.getContextWindowForModel('gemini-4-hydrogen-high') === 200_000)

  console.log('── the effort words with an API key: the level rides the body, and only a level the model\'s own page lists ──')
  const keyHydrogen = await sweep('gemini-4-hydrogen')
  check('gemini-4-hydrogen: low, medium and high go out as LOW, MEDIUM and HIGH; with no word no thinking configuration is sent and Google\'s own default governs', levelOf(keyHydrogen.low!) === level('LOW') && levelOf(keyHydrogen.medium!) === level('MEDIUM') && levelOf(keyHydrogen.high!) === level('HIGH') && keyHydrogen.none!.generationConfig === undefined, j([keyHydrogen.low!.generationConfig, keyHydrogen.medium!.generationConfig, keyHydrogen.high!.generationConfig, keyHydrogen.none!.generationConfig]))
  check('gemini-4-hydrogen: xhigh goes out as XHIGH, the fourth level Hydrogen\'s page lists', levelOf(keyHydrogen.xhigh!) === level('XHIGH'), levelOf(keyHydrogen.xhigh!))
  check('gemini-4-hydrogen: max lands on XHIGH, the highest level the model has', levelOf(keyHydrogen.max!) === level('XHIGH'), levelOf(keyHydrogen.max!))
  check('…and the turn is stamped with what went out: asked xhigh, applied xhigh', stampOf(keyHydrogen.xhigh!).asked === 'xhigh' && stampOf(keyHydrogen.xhigh!).applied === 'xhigh' && stampOf(keyHydrogen.max!).applied === 'xhigh', j([stampOf(keyHydrogen.xhigh!), stampOf(keyHydrogen.max!)]))
  check('gemini-4-hydrogen with thinking switched off sends LOW: a Gemini 4 model cannot stop thinking, and neither a budget nor MINIMAL is a value its page takes', levelOf(await plain('gemini-4-hydrogen', { effort: 'xhigh', thinking: false })) === level('LOW'))
  check('the model list says what the wire takes on gemini-4-hydrogen: efforts low · medium · high · xhigh', listWords('gemini-4-hydrogen') === 'efforts low · medium · high · xhigh', listWords('gemini-4-hydrogen'))
  for (const three of ['gemini-4-carbon', 'gemini-4-argon', 'gemini-3.8-flash']) {
    const sent = await sweep(three)
    check(`${three}: its page stops at high, so xhigh and max go out as HIGH and the list says efforts low · medium · high, as before`, levelOf(sent.low!) === level('LOW') && levelOf(sent.medium!) === level('MEDIUM') && levelOf(sent.high!) === level('HIGH') && levelOf(sent.xhigh!) === level('HIGH') && levelOf(sent.max!) === level('HIGH') && sent.none!.generationConfig === undefined && stampOf(sent.xhigh!).applied === 'high' && listWords(three) === 'efforts low · medium · high', j([levelOf(sent.xhigh!), levelOf(sent.max!), listWords(three)]))
  }
  const legacy = await sweep('gemini-2.5-pro')
  check('gemini-2.5-pro keeps its token budgets (1024, 8192, 24576) and never receives a level', j(legacy.low!.generationConfig) === j({ thinkingConfig: { thinkingBudget: 1024 } }) && j(legacy.medium!.generationConfig) === j({ thinkingConfig: { thinkingBudget: 8192 } }) && j(legacy.high!.generationConfig) === j({ thinkingConfig: { thinkingBudget: 24576 } }) && j(legacy.xhigh!.generationConfig) === j({ thinkingConfig: { thinkingBudget: 24576 } }) && j(legacy.max!.generationConfig) === j({ thinkingConfig: { thinkingBudget: 24576 } }), j([legacy.low!.generationConfig, legacy.xhigh!.generationConfig]))

  console.log('── the effort words on the Google sign-in: low, medium and high ride the body on every row; XHIGH is named by the id of the -xhigh row ──')
  await useRoad('plan')
  const signBare = await sweep('gemini-4-hydrogen')
  check('the bare gemini-4-hydrogen rides the row of the word, the same level in the body: low, medium, high; no word rides -high with no level', j([signBare.low!.wireModel, levelOf(signBare.low!), signBare.medium!.wireModel, levelOf(signBare.medium!), signBare.high!.wireModel, levelOf(signBare.high!), signBare.none!.wireModel, signBare.none!.generationConfig?.thinkingConfig]) === j(['gemini-4-hydrogen-low', level('LOW'), 'gemini-4-hydrogen-medium', level('MEDIUM'), 'gemini-4-hydrogen-high', level('HIGH'), 'gemini-4-hydrogen-high', undefined]), j([signBare.low!.wireModel, levelOf(signBare.low!), signBare.none!.wireModel, signBare.none!.generationConfig]))
  check('the bare gemini-4-hydrogen at xhigh rides gemini-4-hydrogen-xhigh and sends no level, so the id names it (the one shape read live to think at XHIGH: 9,333 thought tokens where LOW in the body on the same row thought 1,569)', signBare.xhigh!.wireModel === 'gemini-4-hydrogen-xhigh' && signBare.xhigh!.generationConfig?.thinkingConfig === undefined, j([signBare.xhigh!.wireModel, signBare.xhigh!.generationConfig]))
  check('…and at max the same row, the same way', signBare.max!.wireModel === 'gemini-4-hydrogen-xhigh' && signBare.max!.generationConfig?.thinkingConfig === undefined, j([signBare.max!.wireModel, signBare.max!.generationConfig]))
  check('…stamped asked xhigh, applied xhigh', stampOf(signBare.xhigh!).asked === 'xhigh' && stampOf(signBare.xhigh!).applied === 'xhigh', j(stampOf(signBare.xhigh!)))
  const signXhigh = await sweep('gemini-4-hydrogen-xhigh')
  check('on the gemini-4-hydrogen-xhigh row xhigh and max send no level: the row\'s own id names XHIGH', signXhigh.xhigh!.wireModel === 'gemini-4-hydrogen-xhigh' && signXhigh.xhigh!.generationConfig?.thinkingConfig === undefined && signXhigh.max!.generationConfig?.thinkingConfig === undefined && stampOf(signXhigh.xhigh!).applied === 'xhigh', j([signXhigh.xhigh!.generationConfig, signXhigh.max!.generationConfig, stampOf(signXhigh.xhigh!)]))
  check('THE OWNER\'S OWN CASE: the -xhigh row with the dial at high sends HIGH in the body (the dial wins over a row\'s name, as on every tier row), the turn is stamped applied high, the dial\'s label reads high and the status row shows the row with no ride', levelOf(signXhigh.high!) === level('HIGH') && signXhigh.high!.wireModel === 'gemini-4-hydrogen-xhigh' && stampOf(signXhigh.high!).applied === 'high' && effort.resolveEffortTruth('gemini-4-hydrogen-xhigh', 'high', { thinkingEnabled: true }).label === 'high' && catalogue.geminiPlanRideWords('gemini-4-hydrogen-xhigh', 'high') === undefined && resolveDisplayedSessionModel('gemini-4-hydrogen-xhigh', null, catalogue.geminiPlanRideWords('gemini-4-hydrogen-xhigh', 'high')).compact === 'gemini-4-hydrogen-xhigh', j([levelOf(signXhigh.high!), stampOf(signXhigh.high!), effort.resolveEffortTruth('gemini-4-hydrogen-xhigh', 'high', { thinkingEnabled: true }).label]))
  check('…and low and medium on that row ride the body too; no word sends nothing and the row\'s own level runs', levelOf(signXhigh.low!) === level('LOW') && levelOf(signXhigh.medium!) === level('MEDIUM') && signXhigh.none!.generationConfig?.thinkingConfig === undefined)
  check('the model list says what is true of the XHigh row: efforts low · medium · high · xhigh', listWords('gemini-4-hydrogen-xhigh') === 'efforts low · medium · high · xhigh', listWords('gemini-4-hydrogen-xhigh'))
  for (const tier of ['gemini-4-hydrogen-low', 'gemini-4-hydrogen-medium', 'gemini-4-hydrogen-high']) {
    const sent = await sweep(tier)
    const truth = effort.resolveEffortTruth(tier, 'xhigh', { thinkingEnabled: true })
    check(`${tier}: xhigh and max stay clamped to HIGH on its own id, the receipt says asked xhigh applied high, and its list line is unmoved`, sent.xhigh!.wireModel === tier && levelOf(sent.xhigh!) === level('HIGH') && levelOf(sent.max!) === level('HIGH') && stampOf(sent.xhigh!).asked === 'xhigh' && stampOf(sent.xhigh!).applied === 'high' && truth.wire === 'high' && truth.adjustedFrom === 'xhigh' && listWords(tier) === 'efforts low · medium · high' && levelOf(sent.low!) === level('LOW') && sent.low!.wireModel === tier, j([sent.xhigh!.wireModel, levelOf(sent.xhigh!), stampOf(sent.xhigh!), listWords(tier)]))
  }
  const signCarbon = await sweep('gemini-4-carbon')
  const signCarbonHigh = await sweep('gemini-4-carbon-high')
  check('Carbon, whose roster names no -xhigh row: the bare id at xhigh and max rides -high with HIGH, the -high row sends HIGH, and both list efforts low · medium · high', signCarbon.xhigh!.wireModel === 'gemini-4-carbon-high' && levelOf(signCarbon.xhigh!) === level('HIGH') && signCarbon.max!.wireModel === 'gemini-4-carbon-high' && levelOf(signCarbon.max!) === level('HIGH') && levelOf(signCarbonHigh.xhigh!) === level('HIGH') && levelOf(signCarbonHigh.low!) === level('LOW') && listWords('gemini-4-carbon-high') === 'efforts low · medium · high' && listWords('gemini-4-carbon') === 'efforts low · medium · high', j([signCarbon.xhigh!.wireModel, levelOf(signCarbon.xhigh!), listWords('gemini-4-carbon')]))
  check('the bare gemini-4-hydrogen lists the four words its rows reach', listWords('gemini-4-hydrogen') === 'efforts low · medium · high · xhigh', listWords('gemini-4-hydrogen'))
  check('the status row says the ride: gemini-4-hydrogen ▸ gemini-4-hydrogen-xhigh at xhigh and at max, ▸ gemini-4-hydrogen-high at high', resolveDisplayedSessionModel('gemini-4-hydrogen', null, catalogue.geminiPlanRideWords('gemini-4-hydrogen', 'xhigh')).compact === 'gemini-4-hydrogen ▸ gemini-4-hydrogen-xhigh' && catalogue.geminiPlanRideWords('gemini-4-hydrogen', 'max') === 'gemini-4-hydrogen-xhigh' && catalogue.geminiPlanRideWords('gemini-4-hydrogen', 'high') === 'gemini-4-hydrogen-high' && catalogue.geminiPlanRideWords('gemini-4-carbon', 'xhigh') === 'gemini-4-carbon-high', j([catalogue.geminiPlanRideWords('gemini-4-hydrogen', 'xhigh'), catalogue.geminiPlanRideWords('gemini-4-carbon', 'xhigh')]))
  const quotaFigures = ['low', 'medium', 'high', 'xhigh'].map(tier => ({ key: `plan-quota:gemini-4-hydrogen-${tier}`, label: `gemini-4-hydrogen-${tier}`, value: '80% left' }))
  check('/usage reads the quota of the row the session rides: -xhigh at xhigh and max, -high at high', geminiPlanQuotaView(quotaFigures, { model: 'gemini-4-hydrogen', effort: 'xhigh', usedModels: [] }).activeRow === 'gemini-4-hydrogen-xhigh' && geminiPlanQuotaView(quotaFigures, { model: 'gemini-4-hydrogen', effort: 'max', usedModels: [] }).activeRow === 'gemini-4-hydrogen-xhigh' && geminiPlanQuotaView(quotaFigures, { model: 'gemini-4-hydrogen', effort: 'high', usedModels: [] }).activeRow === 'gemini-4-hydrogen-high' && geminiPlanQuotaView(quotaFigures.slice(0, 3), { model: 'gemini-4-hydrogen', effort: 'xhigh', usedModels: [] }).activeRow === 'gemini-4-hydrogen-high', j(geminiPlanQuotaView(quotaFigures, { model: 'gemini-4-hydrogen', effort: 'xhigh', usedModels: [] }).activeRow))
  const tierLaw = catalogue.geminiPlanWireModel
  check('the effort row law keeps every older reading: a missing tier takes the nearest present, an exact row never resolves, minimal takes low', tierLaw('gemini-3.8-flash', 'xhigh') === 'gemini-3.8-flash-high' && tierLaw('gemini-3.8-flash', 'max') === 'gemini-3.8-flash-high' && tierLaw('gemini-3.8-flash', 'minimal') === 'gemini-3.8-flash-low' && tierLaw('gemini-4-hydrogen-high', 'xhigh') === 'gemini-4-hydrogen-high' && tierLaw('gemini-4-hydrogen-xhigh', 'low') === 'gemini-4-hydrogen-xhigh' && tierLaw('gemini-3-flash', 'xhigh') === 'gemini-3-flash')

  console.log('── the output ceiling of a Gemini 4 row is one streamed segment, 65,536, on both roads ──')
  for (const signIn of ['gemini-4-hydrogen-low', 'gemini-4-hydrogen-medium', 'gemini-4-hydrogen-high', 'gemini-4-hydrogen-xhigh', 'gemini-4-hydrogen', 'gemini-4-carbon-low', 'gemini-4-carbon-medium', 'gemini-4-carbon-high', 'gemini-4-carbon', 'gemini-4-argon-low', 'gemini-4-argon-medium', 'gemini-4-argon-high', 'gemini-4-argon']) {
    const sent = await plain(signIn, { effort: 'high' })
    check(`sign-in ${signIn}: the request asks 65,536 where the roster's 262,144 opened a long decode nothing followed`, sent.generationConfig?.maxOutputTokens === SEGMENT && capabilities.getModelMaxOutputTokens(signIn).upperLimit === SEGMENT && capabilities.getModelMaxOutputTokens(signIn).default === SEGMENT, j([sent.generationConfig?.maxOutputTokens, capabilities.getModelMaxOutputTokens(signIn)]))
  }
  const olderRow = await plain('gemini-3.8-flash-high', { effort: 'high' })
  check('sign-in gemini-3.8-flash-high keeps the ceiling its roster row states', olderRow.generationConfig?.maxOutputTokens === 65_536 && capabilities.getModelMaxOutputTokens('gemini-3.8-flash-high').upperLimit === 65_536)
  for (const row of ['gemini-4-hydrogen-high', 'gemini-4-carbon-high']) {
    const cut = await runTurn(row, 'Prove it.', [cutAfterThinking])
    const notice = cut.notices.find(words => words.includes('thinking ran to the output limit')) ?? ''
    check(`sign-in ${row}: a reply cut after thinking only is told with the ceiling the cut came at, 65536, where the roster's figure clipped at the loop's default read 128k`, notice === 'thinking ran to the output limit (65536) — continuing', notice)
    check(`…and the loop does there what it did before the ceiling moved (the same count on the tree before this): one continuation, two requests in all, the second ending on the loop's own nudge, and the turn completes`, cut.requests.length === 2 && cut.terminal === 'completed' && cut.answers.at(-1) === 'ok' && cut.requests[1]!.contents.at(-1)?.role === 'user' && j(cut.requests[1]!.contents.at(-1)?.parts.at(-1)).includes('your last turn carried thinking only'), j([cut.requests.length, cut.terminal, cut.answers, cut.requests[1]?.contents.at(-1)]))
  }
  const olderCut = await runTurn('gemini-3.8-flash-high', 'Prove it.', [cutAfterThinking])
  check('sign-in gemini-3.8-flash-high: the same notice with its own row\'s figure, as before', olderCut.notices.includes('thinking ran to the output limit (65536) — continuing') && olderCut.requests.length === 2, j(olderCut.notices))
  await useRoad('api-key')
  for (const keyed of ['gemini-4-hydrogen', 'gemini-4-carbon', 'gemini-4-argon']) {
    const unasked = await plain(keyed, { effort: 'high' })
    const asked = await plain(keyed, { effort: 'high', maxOutput: 200_000 })
    check(`API key ${keyed}: no ceiling is sent unasked (Google's own 65,536 governs) and a larger ask goes out as one segment`, unasked.generationConfig?.maxOutputTokens === undefined && asked.generationConfig?.maxOutputTokens === SEGMENT && (await plain(keyed, { effort: 'high', maxOutput: 4_096 })).generationConfig?.maxOutputTokens === 4_096, j([unasked.generationConfig, asked.generationConfig]))
  }
  check('API key gemini-3.8-flash and gemini-2.5-pro send what was asked, as before', (await plain('gemini-3.8-flash', { maxOutput: 200_000 })).generationConfig?.maxOutputTokens === 200_000 && (await plain('gemini-2.5-pro', { maxOutput: 200_000 })).generationConfig?.maxOutputTokens === 200_000)
  await useRoad('plan')

  console.log('── what no request carried ──')
  const gemini4 = sentLog.filter(sent => /^gemini-4-/.test(sent.model))
  const allowed: Record<string, readonly string[]> = { hydrogen: ['LOW', 'MEDIUM', 'HIGH', 'XHIGH'], carbon: ['LOW', 'MEDIUM', 'HIGH'], argon: ['LOW', 'MEDIUM', 'HIGH'] }
  const strays = gemini4.filter(sent => {
    const config = (sent.request.generationConfig ?? {}) as Record<string, any>
    const thinking = (config.thinkingConfig ?? {}) as Record<string, unknown>
    const family = /^gemini-4-([a-z]+)/.exec(sent.model)![1]!
    return Object.keys(config).some(name => name !== 'maxOutputTokens' && name !== 'thinkingConfig') || Object.keys(thinking).some(name => name !== 'thinkingLevel') || (thinking.thinkingLevel !== undefined && !(allowed[family] ?? []).includes(String(thinking.thinkingLevel)))
  })
  check(`of ${gemini4.length} requests to a Gemini 4 model on the two roads, none carries a budget, MINIMAL, a sampling or penalty parameter, a candidate count, a level its model's page does not list, or a field no page of its road documents (no prefix-mismatch field)`, gemini4.length >= 60 && strays.length === 0 && !j(gemini4).includes('prefixMismatch'), j(strays.slice(0, 2)))

  console.log('── the page says what the code does ──')
  const engines = readFileSync(join(ROOT, 'docs/ENGINES.md'), 'utf8').replace(/\s+/g, ' ')
  check('docs/ENGINES.md carries the effort row law with the fourth tier', engines.includes('(low → `-low`, medium → `-medium`, high or no effort → `-high`, xhigh or max → `-xhigh` where the roster names that row, as it does for Gemini 4 Hydrogen, and `-high` where it does not; a missing tier taking the nearest present)'))
  check('docs/ENGINES.md says which plans carry Hydrogen and when the three older rows leave, as Google\'s plan table read on 2026-11-15', engines.includes('read again on 2026-11-15 it lists Gemini 4 Hydrogen on every plan, Free and Google AI Plus included, with a fourth thinking level (Extra, the row `…-xhigh`)') && engines.includes('GPT-OSS-120b leave the roster on November 18, 2026 (the table read on 2026-11-15)') && !engines.includes('leave the roster on November 2, 2026'))
} finally {
  globalThis.fetch = realFetch
}
console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
