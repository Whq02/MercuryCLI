#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { writeFileSync } from 'node:fs'
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
let script: unknown[][] = []
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
  hits.push({ url, body: JSON.parse(String(init?.body ?? '{}')) })
  const plan = url.includes('/v1internal:')
  return sse(script.shift() ?? plainAnswer, plan)
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
  return { wireModel: body.model as string | undefined, request, generationConfig: request.generationConfig as Record<string, any> | undefined, answer }
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
} finally {
  globalThis.fetch = realFetch
}
console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
