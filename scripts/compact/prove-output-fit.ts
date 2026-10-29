#!/usr/bin/env bun
// gate-watch: src/services/api/outputFit.ts src/services/api/withRetry.ts src/services/providers/anthropic/streamCore.ts src/services/providers/zai/zaiCallModel.ts src/services/providers/gemini/geminiCallModel.ts src/services/providers/openaicompat/compatChatCallModel.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — output fit prover exceeded 180s')
  process.exit(1)
}, 180_000)
watchdog.unref?.()

delete process.env.NODE_ENV
for (const ambient of [
  'ANTHROPIC_API_KEY', 'MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE',
  'GOOGLE_API_KEY', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_OVERFLOW_RECOVERY', 'MERCURY_MAX_OUTPUT_TOKENS',
]) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'output-fit-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'output-fit-daemon-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const { startOverflowFixture } = await import('./overflowFixture.ts')
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)

console.log('============================================================')
console.log(' the output cap is fitted to the window the prompt leaves, before the request, on every route that sends one')
console.log(' S1 the arithmetic: untouched while it fits; the room the window leaves otherwise; never under the floor, never under the thinking budget, never raised')
console.log(' S2 the prompt measure: the usage anchor plus the tail; a fresh conversation adds the fixed material; the reactive retry shares the headway and the floor')
console.log(' S3 the request bytes over the loopback: Anthropic, Z.AI, Gemini, a compat lane with an override, the Responses road (no cap, before and after)')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const fitModule = await import('../../src/services/api/outputFit.ts').catch(() => null)
const HEADWAY = 1_000
const FLOOR = 3_000
const { messageContextFill } = await import('../../src/utils/tokens.ts')
const { getContextWindowForModel, getModelMaxOutputTokens } = await import('../../src/utils/model/capabilities.ts')
const { getMaxOutputTokensForModel } = await import('../../src/services/providers/anthropic/streamCore.ts')
const ZAI_DOCUMENTED_OUTPUT_CEILING = 131_072
const { geminiOutputTokenLimitFor, refreshGeminiCatalogue } = await import('../../src/services/providers/gemini/geminiCatalogue.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

type AnyMsg = Record<string, unknown> & { type?: string }

section('S1 the arithmetic')
check('the output fit module exists (src/services/api/outputFit.ts)', fitModule !== null)
if (fitModule !== null) {
  const { fitOutputTokens, OUTPUT_FIT_HEADWAY_TOKENS, OUTPUT_FIT_FLOOR_TOKENS } = fitModule
  check(`the headway is ${OUTPUT_FIT_HEADWAY_TOKENS} tokens and the floor ${OUTPUT_FIT_FLOOR_TOKENS}`, OUTPUT_FIT_HEADWAY_TOKENS === 1_000 && OUTPUT_FIT_FLOOR_TOKENS === 3_000)
  const fits = fitOutputTokens({ asked: 64_000, window: 200_000, promptTokens: 100_000 })
  check('an ask the window holds goes out untouched', fits.tokens === 64_000 && !fits.clamped && fits.room === 99_000, JSON.stringify(fits))
  const edge = fitOutputTokens({ asked: 64_000, window: 200_000, promptTokens: 135_000 })
  check('an ask exactly at the room goes out untouched', edge.tokens === 64_000 && !edge.clamped, JSON.stringify(edge))
  const over = fitOutputTokens({ asked: 64_000, window: 200_000, promptTokens: 150_000 })
  check('an ask over the room is fitted to the room (window − prompt − headway)', over.tokens === 49_000 && over.clamped && over.asked === 64_000, JSON.stringify(over))
  const floor = fitOutputTokens({ asked: 64_000, window: 200_000, promptTokens: 198_500 })
  check('a room under the floor sends the floor, never less (the wire answers the overflow, the ladder folds)', floor.tokens === 3_000 && floor.clamped, JSON.stringify(floor))
  const budget = fitOutputTokens({ asked: 64_000, window: 200_000, promptTokens: 190_000, least: 32_001 })
  check('the thinking budget is never cut by the fit: least beats the room and the floor', budget.tokens === 32_001 && budget.clamped, JSON.stringify(budget))
  const small = fitOutputTokens({ asked: 100, window: 200_000, promptTokens: 1_000 })
  check('a small explicit ask is never raised', small.tokens === 100 && !small.clamped, JSON.stringify(small))
  const smallOver = fitOutputTokens({ asked: 2_000, window: 200_000, promptTokens: 199_500 })
  check('a small ask under the floor is never raised to it', smallOver.tokens === 2_000 && !smallOver.clamped, JSON.stringify(smallOver))
  const noWindow = fitOutputTokens({ asked: 64_000, window: 0, promptTokens: 150_000 })
  check('an unknown window changes nothing', noWindow.tokens === 64_000 && !noWindow.clamped)
  const noPrompt = fitOutputTokens({ asked: 64_000, window: 200_000, promptTokens: 0 })
  check('an unknown prompt size changes nothing', noPrompt.tokens === 64_000 && !noPrompt.clamped)
  const retry = readFileSync(join(ROOT, 'src/services/api/withRetry.ts'), 'utf8')
  check('source pin: the reactive retry after the Anthropic overflow shares the headway and the floor (one owner)', retry.includes('OUTPUT_FIT_HEADWAY_TOKENS') && retry.includes('OUTPUT_FIT_FLOOR_TOKENS') && !/SAFETY_BUFFER = 1000/.test(retry))
}

const settledReply = (model: string, inputTokens: number, text = 'an earlier reply'): unknown => ({
  type: 'assistant',
  uuid: `00000000-0000-4000-a000-${String(inputTokens).padStart(12, '0')}`,
  requestId: `r${inputTokens}`,
  message: {
    id: `msg_${inputTokens}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
})
const conversation = (model: string, inputTokens: number): unknown[] => [
  createUserMessage({ content: 'the first ask' }),
  settledReply(model, inputTokens),
  createUserMessage({ content: 'fixture ask' }),
]

section('S2 the prompt measure')
if (fitModule !== null) {
  const { promptRoomOf } = fitModule
  const model = 'claude-opus-4-8'
  const window = getContextWindowForModel(model)
  const anchored = conversation(model, window - 40_000) as never
  const measured = promptRoomOf(anchored, model, ['system', []])
  const fill = messageContextFill(anchored, model)
  check(`a settled reply's usage anchors the measure (${fill.tokens} by usage, window ${window})`, fill.source === 'usage' && measured.promptTokens === fill.tokens && measured.promptTokens > window - 40_000 && measured.window === window, JSON.stringify(measured))
  const fresh = [createUserMessage({ content: 'a fresh ask' })] as never
  const bare = promptRoomOf(fresh, model, '')
  const withFixed = promptRoomOf(fresh, model, 'x'.repeat(40_000))
  check('a fresh conversation adds the fixed material (system prompt + tools) to the estimate', withFixed.promptTokens - bare.promptTokens === 10_000, `${bare.promptTokens} → ${withFixed.promptTokens}`)
  const foreign = conversation('gpt-5.6-sol', window - 40_000) as never
  const fenced = promptRoomOf(foreign, model, '')
  check('an anchor stamped by another family is fenced: the measure falls to the estimate', fenced.promptTokens < 10_000, JSON.stringify(fenced))
}

section('S3 the request bytes over the loopback')
async function call(model: string, messages: unknown[], extra: Record<string, unknown> = {}): Promise<{ body: Record<string, unknown> | null; errors: AnyMsg[] }> {
  const before = fixture.captured.length
  fixture.script([{ text: 'fixture reply' }])
  const errors: AnyMsg[] = []
  const stream = routedCallModel({
    messages: messages as never,
    systemPrompt: asSystemPrompt(['fixture system prompt']),
    thinkingConfig: { type: 'disabled' },
    tools: [] as never,
    signal: AbortSignal.timeout(30_000),
    options: {
      model,
      querySource: 'sdk',
      agents: [],
      isNonInteractiveSession: true,
      hasAppendSystemPrompt: false,
      mcpTools: [],
      enablePromptCaching: false,
      async getToolPermissionContext() {
        return getEmptyToolPermissionContext()
      },
      ...extra,
    } as never,
  })
  for await (const ev of stream) {
    const m = ev as AnyMsg
    if (m.type === 'assistant' && m.isApiErrorMessage === true) errors.push(m)
  }
  const captured = fixture.captured.slice(before)
  const body = captured.at(-1)?.body as Record<string, unknown> | undefined
  return { body: body ?? null, errors }
}
const capOf = (body: Record<string, unknown> | null): unknown => {
  if (body === null) return undefined
  if ('max_tokens' in body) return body.max_tokens
  if ('max_output_tokens' in body) return body.max_output_tokens
  if ('max_completion_tokens' in body) return body.max_completion_tokens
  const generation = body.generationConfig as Record<string, unknown> | undefined
  return generation?.maxOutputTokens
}
const expectedFit = (model: string, messages: unknown[], asked: number): { tokens: number; room: number } => {
  const fill = messageContextFill(messages as never, model)
  const room = getContextWindowForModel(model) - fill.tokens - HEADWAY
  return { tokens: asked <= room ? asked : Math.min(asked, Math.max(room, FLOOR)), room }
}
{
  const model = 'claude-opus-4-8'
  const window = getContextWindowForModel(model)
  const asked = getMaxOutputTokensForModel(model)
  const plain = await call(model, [createUserMessage({ content: 'fixture ask' })])
  check(`anthropic: a small conversation sends the model's own output ceiling (${asked})`, capOf(plain.body) === asked, `${JSON.stringify(capOf(plain.body))} errors=${plain.errors.length}`)
  const near = conversation(model, window - 40_000)
  const want = expectedFit(model, near, asked)
  const fitted = await call(model, near)
  check(`anthropic: a conversation ${window - 40_000} tokens in sends max_tokens fitted to the room (${want.tokens})`, capOf(fitted.body) === want.tokens && want.tokens < asked, `${JSON.stringify(capOf(fitted.body))} errors=${fitted.errors.length}`)
  const full = await call(model, conversation(model, window - 2_000))
  check('anthropic: a conversation with no room sends the floor, never less', capOf(full.body) === FLOOR, JSON.stringify(capOf(full.body)))
  const asked100 = await call(model, conversation(model, window - 2_000), { maxOutputTokensOverride: 100 })
  check('anthropic: an explicit small ask rides untouched', capOf(asked100.body) === 100, JSON.stringify(capOf(asked100.body)))
}
{
  const model = 'glm-5.2'
  const window = getContextWindowForModel(model)
  const plain = await call(model, [createUserMessage({ content: 'fixture ask' })])
  check(`zai: a small conversation sends the documented ceiling (${ZAI_DOCUMENTED_OUTPUT_CEILING})`, capOf(plain.body) === ZAI_DOCUMENTED_OUTPUT_CEILING, `${JSON.stringify(capOf(plain.body))} errors=${plain.errors.length}`)
  const near = conversation(model, window - 40_000)
  const want = expectedFit(model, near, ZAI_DOCUMENTED_OUTPUT_CEILING)
  const fitted = await call(model, near)
  check(`zai: a conversation ${window - 40_000} tokens in sends max_tokens fitted to the room (${want.tokens})`, capOf(fitted.body) === want.tokens && want.tokens < ZAI_DOCUMENTED_OUTPUT_CEILING, `${JSON.stringify(capOf(fitted.body))} errors=${fitted.errors.length}`)
}
{
  const model = 'gemini-3-pro'
  const listing = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      return Response.json({ models: [{ name: `models/${model}`, inputTokenLimit: 1_048_576, outputTokenLimit: 65_536, supportedGenerationMethods: ['generateContent'] }] })
    },
  })
  const fixtureBase = process.env.MERCURY_GEMINI_API_BASE
  process.env.MERCURY_GEMINI_API_BASE = `http://127.0.0.1:${listing.port}/v1beta`
  await refreshGeminiCatalogue('api-key', { force: true })
  process.env.MERCURY_GEMINI_API_BASE = fixtureBase
  listing.stop(true)
  const window = getContextWindowForModel(model)
  const ceiling = geminiOutputTokenLimitFor(model)
  check(`gemini: the live row states the window (${window}) and the output ceiling (${ceiling})`, window === 1_048_576 && ceiling === 65_536)
  const plain = await call(model, [createUserMessage({ content: 'fixture ask' })])
  check('gemini (key road): no override sends no maxOutputTokens, as before', plain.body !== null && capOf(plain.body) === undefined, `${JSON.stringify(capOf(plain.body))} errors=${plain.errors.length}`)
  const near = conversation(model, window - 40_000)
  const want = expectedFit(model, near, 60_000)
  const fitted = await call(model, near, { maxOutputTokensOverride: 60_000 })
  check(`gemini (key road): an override of 60000 on a conversation ${window - 40_000} tokens in sends maxOutputTokens fitted to the room (${want.tokens})`, capOf(fitted.body) === want.tokens && want.tokens < 60_000, `${JSON.stringify(capOf(fitted.body))} errors=${fitted.errors.length}`)
  const plan = readFileSync(join(ROOT, 'src/services/providers/gemini/geminiCallModel.ts'), 'utf8')
  const planTransport = plan.slice(plan.indexOf('async function* geminiPlanCallModel'), plan.indexOf('export async function* geminiCallModel'))
  check('source pin: the plan road, which always sends the catalogue ceiling, fits it to the room the same way', planTransport.includes('fitOutputTokensForRequest({ asked: capped') && planTransport.includes('max_tokens: fitted'))
}
{
  const model = 'deepseek-v4-pro'
  const window = getContextWindowForModel(model)
  const plain = await call(model, [createUserMessage({ content: 'fixture ask' })])
  check('compat (deepseek): no override sends no output cap at all, as before', plain.body !== null && capOf(plain.body) === undefined, `${JSON.stringify(capOf(plain.body))} errors=${plain.errors.length}`)
  const near = conversation(model, window - 20_000)
  const want = expectedFit(model, near, 60_000)
  const fitted = await call(model, near, { maxOutputTokensOverride: 60_000 })
  check(`compat (deepseek): an override of 60000 on a conversation ${window - 20_000} tokens in is fitted to the room (${want.tokens})`, capOf(fitted.body) === want.tokens && want.tokens < 60_000, `${JSON.stringify(capOf(fitted.body))} errors=${fitted.errors.length}`)
  const asked100 = await call(model, [createUserMessage({ content: 'fixture ask' })], { maxOutputTokensOverride: 100 })
  check('compat (deepseek): a small override rides untouched', capOf(asked100.body) === 100, JSON.stringify(capOf(asked100.body)))
  const upper = getModelMaxOutputTokens(model).upperLimit
  check(`compat (deepseek): the model's stated output ceiling is unchanged by the fit (${upper})`, getModelMaxOutputTokens(model).upperLimit === upper)
}
{
  const model = 'gpt-5.6-sol'
  const window = getContextWindowForModel(model)
  const plain = await call(model, [createUserMessage({ content: 'fixture ask' })])
  const near = await call(model, conversation(model, window - 40_000))
  check('responses road: no output cap before and none after (the wire sends none)', plain.body !== null && near.body !== null && capOf(plain.body) === undefined && capOf(near.body) === undefined, `${JSON.stringify(capOf(plain.body))}/${JSON.stringify(capOf(near.body))}`)
}

section('refusals — bad numbers, no room at all, the thinking budget, the control')
if (fitModule !== null) {
  const { fitOutputTokens } = fitModule
  for (const asked of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const fit = fitOutputTokens({ asked, window: 200_000, promptTokens: 150_000 })
    check(`an ask that is not a positive number rides untouched (${asked})`, Object.is(fit.tokens, asked) && !fit.clamped, JSON.stringify(fit))
  }
  for (const promptTokens of [Number.NaN, -10, Number.POSITIVE_INFINITY]) {
    const fit = fitOutputTokens({ asked: 64_000, window: 200_000, promptTokens })
    check(`a prompt measure that is not a positive number changes nothing (${promptTokens})`, fit.tokens === 64_000 && !fit.clamped, JSON.stringify(fit))
  }
  const beyond = fitOutputTokens({ asked: 64_000, window: 200_000, promptTokens: 400_000 })
  check('a prompt already past the window sends the floor, never a negative or zero cap', beyond.tokens === FLOOR && beyond.clamped, JSON.stringify(beyond))
  const budgetBeyond = fitOutputTokens({ asked: 64_000, window: 200_000, promptTokens: 400_000, least: 32_001 })
  check('…and a thinking budget past the room stands whole (the wire answers the overflow; thinking is never cut)', budgetBeyond.tokens === 32_001, JSON.stringify(budgetBeyond))
  const leastAboveAsk = fitOutputTokens({ asked: 8_000, window: 200_000, promptTokens: 199_000, least: 32_001 })
  check('the least never raises the cap above what was asked', leastAboveAsk.tokens === 8_000, JSON.stringify(leastAboveAsk))
  const model = 'claude-opus-4-8'
  const budgeted = await call(model, conversation(model, getContextWindowForModel(model) - 2_000), { thinkingConfig: { type: 'enabled', budgetTokens: 10_000 } } as never)
  check('the control for thinking: a budget model near the window keeps budget_tokens below max_tokens by the base\'s own law', budgeted.body !== null && (typeof budgeted.body.thinking !== 'object' || budgeted.body.thinking === null || !('budget_tokens' in (budgeted.body.thinking as Record<string, unknown>)) || ((budgeted.body.thinking as { budget_tokens: number }).budget_tokens < (budgeted.body.max_tokens as number))), JSON.stringify({ thinking: budgeted.body?.thinking, max_tokens: budgeted.body?.max_tokens }))
  const small = await call(model, [createUserMessage({ content: 'fixture ask' })])
  const keys = Object.keys(small.body ?? {}).sort()
  check('the control: a small conversation\'s Anthropic body carries the same keys as before and the ceiling (the dialect byte-parity proofs pin the whole body)', keys.includes('max_tokens') && keys.includes('messages') && keys.includes('model') && small.body?.max_tokens === getMaxOutputTokensForModel(model), keys.join(','))
}

await fixture.close()
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
