#!/usr/bin/env bun
// gate-watch: src/services/api/overflowSignal.ts src/services/providers/openaicompat/compatChatCallModel.ts src/services/providers/local/localCallModel.ts src/services/compact/overflowRecovery.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
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
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — overflow phrasings prover exceeded 180s')
  process.exit(1)
}, 180_000)
watchdog.unref?.()

delete process.env.NODE_ENV
for (const ambient of [
  'ANTHROPIC_API_KEY', 'MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE',
  'GOOGLE_API_KEY', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_OVERFLOW_RECOVERY',
]) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'overflow-phrasings-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'overflow-phrasings-daemon-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const { startOverflowFixture } = await import('./overflowFixture.ts')
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)

console.log('============================================================')
console.log(' context-overflow phrasings — the second census')
console.log(' S1 the provider phrasings the first census missed, each a typed signal with its numbers')
console.log(' S2 the exclusions: a per-minute allowance on 413, a 400 naming a rate limit or quota, the output cap, the bare remedy clause, unrelated 400s')
console.log(' S3 a bodiless 400 read against a measure: nothing without one, nothing when small, context-size at the near-window share; a bodiless 413 keeps the body-cap shape')
console.log(' S4 the same at the REAL compat seam over the loopback: a small request stays a plain error, a near-window request carries the stamp with Mercury\'s count')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const signalMod = await import('../../src/services/api/overflowSignal.ts')
const { classifyOverflowFault, overflowSignalOf, overflowWhoClause } = signalMod
const { mapCompatHttpFailure } = await import('../../src/services/providers/openaicompat/compatChatClient.ts')
const { getAssistantMessageFromError } = await import('../../src/services/api/errors.ts')
const { APIError } = await import('../../src/services/api/sdkErrors.js')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { getContextWindowForModel } = await import('../../src/utils/model/capabilities.ts')
const { measureOverflow } = await import('../../src/services/compact/overflowRecovery.ts')

type Sig = import('../../src/services/api/overflowSignal.ts').OverflowSignal
type AnyMsg = Record<string, unknown> & { type?: string }

const viaCompat = (family: string, status: number, body: unknown): Sig | null => {
  const fault = mapCompatHttpFailure(status, body)
  return classifyOverflowFault({ family: family as never, status: fault.status, code: fault.code, message: fault.message })
}

section('S1 the phrasings — each a typed signal with the numbers it carries')
{
  const rows: Array<{ label: string; family: string; status: number; body: unknown; shape: string; actual?: number; limit?: number }> = [
    { label: 'managed host: "Input is too long for requested model."', family: 'openai-compat', status: 400, body: { error: { message: 'Input is too long for requested model.', type: 'invalid_request_error' } }, shape: 'context-size' },
    { label: 'managed host: "The model returned the following errors: ... input is too long"', family: 'openai-compat', status: 400, body: { message: 'The model returned the following errors: input is too long for requested model' }, shape: 'context-size' },
    { label: '"number of input tokens exceeds maximum length"', family: 'openai-compat', status: 400, body: { error: { message: 'Malformed input request: number of input tokens exceeds maximum length, please reformat your input and try again.' } }, shape: 'context-size' },
    { label: '"maximum prompt length is 131072" with the request size', family: 'xai', status: 400, body: { error: 'This model\'s maximum prompt length is 131072 but the request contains 150000 tokens.' }, shape: 'context-length-exceeded', actual: 150_000, limit: 131_072 },
    { label: '"maximum prompt length is 32768" alone', family: 'openai-compat', status: 400, body: { error: { message: 'The maximum prompt length is 32768 tokens.' } }, shape: 'context-length-exceeded', limit: 32_768 },
    { label: '"Prompt contains N tokens … too large for model with M maximum context length"', family: 'mistral', status: 400, body: { message: 'Prompt contains 40000 tokens and 0 draft tokens, too large for model with 32768 maximum context length', type: 'invalid_request_error' }, shape: 'context-length-exceeded', actual: 40_000, limit: 32_768 },
    { label: 'TGI: "`inputs` must have less than N tokens. Given: M"', family: 'huggingface', status: 422, body: { error: 'Input validation error: `inputs` must have less than 4096 tokens. Given: 5000', error_type: 'validation' }, shape: 'input-validation', actual: 5_000, limit: 4_096 },
    { label: '"too many tokens: … cannot exceed N - received M"', family: 'openai-compat', status: 400, body: { message: 'too many tokens: total number of tokens (prompt and prediction) cannot exceed 4096 - received 5000. Try using a shorter prompt, or enabling prompt truncating.' }, shape: 'token-limit', actual: 5_000, limit: 4_096 },
    { label: '"Prompt 超长"', family: 'zai', status: 400, body: { error: { code: '1261', message: 'Prompt 超长' } }, shape: 'context-size' },
    { label: '"输入内容过长" beside the window word', family: 'zai', status: 400, body: { error: { code: '1261', message: '输入内容过长，请减少上下文' } }, shape: 'context-size' },
    { label: '"prompt tokens exceed the limit"', family: 'openrouter', status: 400, body: { error: { message: 'prompt tokens exceed the limit of this endpoint', code: 400 } }, shape: 'context-size' },
    { label: '"input length exceeds the maximum"', family: 'openai-compat', status: 400, body: { error: { message: 'The input length exceeds the maximum allowed for this model' } }, shape: 'context-size' },
    { label: '"exceeds the maximum number of input tokens"', family: 'openai-compat', status: 400, body: { error: { message: 'The request exceeds the maximum number of input tokens for this model.' } }, shape: 'context-size' },
    { label: '"too many input tokens"', family: 'deepseek', status: 400, body: { error: { message: 'too many input tokens in this request', type: 'invalid_request_error' } }, shape: 'context-size' },
    { label: '"the conversation is too long"', family: 'moonshot', status: 400, body: { error: { message: 'Invalid request: the conversation is too long for this model', type: 'invalid_request_error' } }, shape: 'context-size' },
    { label: 'a 400 "payload too large" body', family: 'openai-compat', status: 400, body: { error: { message: 'Payload too large' } }, shape: 'request-too-large' },
    { label: 'a 400 "request entity too large" body', family: 'local', status: 400, body: { error: 'request entity too large' }, shape: 'request-too-large' },
  ]
  for (const row of rows) {
    const sig = viaCompat(row.family, row.status, row.body)
    check(`${row.label} → ${row.shape}`, sig !== null && sig.shape === row.shape && sig.source === 'provider' && sig.family === row.family, JSON.stringify(sig))
    if (row.actual !== undefined) check(`  … the request size rides (${row.actual})`, sig?.actualTokens === row.actual, String(sig?.actualTokens))
    else check('  … no request size fabricated', sig?.actualTokens === undefined, String(sig?.actualTokens))
    if (row.limit !== undefined) check(`  … the window rides (${row.limit})`, sig?.limitTokens === row.limit, String(sig?.limitTokens))
    else check('  … no window fabricated', sig?.limitTokens === undefined, String(sig?.limitTokens))
  }
  const home = getAssistantMessageFromError(new APIError(400, { error: { message: 'Input is too long for requested model.' } } as never, undefined, undefined as never), 'stranger/managed-model')
  check('the home lane\'s gateway tail reads the managed-host sentence too', overflowSignalOf(home)?.shape === 'context-size', JSON.stringify(overflowSignalOf(home)))
}

section('S2 the exclusions — allowances, output caps, the bare remedy clause, unrelated 400s')
{
  const tpm413 = viaCompat('openai-compat', 413, { error: { message: 'Request too large for model `fixture-model` in organization `org_fixture` service tier `on_demand` on tokens per minute (TPM): Limit 6000, Requested 7000, please reduce your message size and try again.', type: 'tokens', code: 'rate_limit_exceeded' } })
  check('a tokens-per-minute refusal on HTTP 413 is NOT an overflow', tpm413 === null, JSON.stringify(tpm413))
  const nulls: Array<{ label: string; family: string; status?: number; code?: string; message: string }> = [
    { label: 'a 400 naming the rate limit', family: 'openai-compat', status: 400, message: 'Rate limit exceeded for input tokens; the prompt is too long for this minute' },
    { label: 'a 400 naming a quota with the window word', family: 'gemini', status: 400, code: 'api-RESOURCE_EXHAUSTED', message: 'Quota exceeded for input tokens per minute; context length is not the issue' },
    { label: 'a 400 requests-per-day allowance', family: 'openrouter', status: 400, message: 'You exceeded the requests per day limit for this model; input is too long is not the reason' },
    { label: 'the output cap in a new dress', family: 'openai-compat', status: 400, message: 'max_tokens exceeds the maximum output tokens for this model' },
    { label: 'the bare remedy clause', family: 'meta', status: 400, message: 'Please reduce the length of the messages' },
    { label: 'an unrelated 400 with the word prompt', family: 'local', status: 400, message: 'prompt must be a string or an array of strings' },
    { label: 'an unrelated 400 with the word tokens', family: 'local', status: 400, message: 'invalid value for max tokens: expected an integer' },
    { label: 'a 400 image-size refusal', family: 'openai-compat', status: 400, message: 'image exceeds the maximum size of 20 MB' },
    { label: 'the managed-host sentence on a 5xx', family: 'openai-compat', status: 503, message: 'Input is too long for requested model.' },
    { label: 'the managed-host sentence on a 429', family: 'openai-compat', status: 429, message: 'Input is too long for requested model.' },
  ]
  for (const row of nulls) {
    const sig = classifyOverflowFault({ family: row.family as never, status: row.status, code: row.code, message: row.message })
    check(`${row.label} → null`, sig === null, JSON.stringify(sig))
  }
  const sentence = viaCompat('openai', 400, { error: { message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 135000 tokens. Please reduce the length of the messages.", code: 'context_length_exceeded' } })
  check('the remedy clause behind its own sentence keeps the numbers', sentence?.shape === 'context-length-exceeded' && sentence.actualTokens === 135_000 && sentence.limitTokens === 128_000, JSON.stringify(sentence))
}

section('S3 the bodiless 400 — the pure reading against a measure')
{
  const bare = mapCompatHttpFailure(400, undefined)
  check('the compat mapper spells a missing body as the bare status line', bare.message === 'HTTP 400' && bare.code === 'http-400', JSON.stringify(bare))
  const noMeasure = classifyOverflowFault({ family: 'local', status: bare.status, code: bare.code, message: bare.message })
  check('without a measure a bodiless 400 is no overflow', noMeasure === null, JSON.stringify(noMeasure))
  const small = classifyOverflowFault({ family: 'local', status: 400, code: 'http-400', message: 'HTTP 400', measured: () => ({ tokens: 20_000, window: 128_000 }) })
  check('a small request\'s bodiless 400 is no overflow', small === null, JSON.stringify(small))
  const edge = classifyOverflowFault({ family: 'local', status: 400, code: 'http-400', message: 'HTTP 400', measured: () => ({ tokens: Math.floor(128_000 * 0.8) - 1, window: 128_000 }) })
  check('one token under the near-window share: still no overflow', edge === null, JSON.stringify(edge))
  const near = classifyOverflowFault({ family: 'local', status: 400, code: 'http-400', message: 'HTTP 400', measured: () => ({ tokens: Math.floor(128_000 * 0.8), window: 128_000 }) })
  check('at the share: context-size with Mercury\'s count stamped', near?.shape === 'context-size' && near.source === 'provider' && near.measuredTokens === 102_400 && near.measuredWindow === 128_000 && near.actualTokens === undefined && near.limitTokens === undefined, JSON.stringify(near))
  let asked = 0
  const sdkSpelling = classifyOverflowFault({ family: 'unknown', status: 400, message: '400 status code (no body)', measured: () => { asked++; return { tokens: 190_000, window: 200_000 } } })
  check('the SDK\'s "(no body)" spelling reads the same', sdkSpelling?.shape === 'context-size' && asked === 1, JSON.stringify(sdkSpelling))
  const empty = classifyOverflowFault({ family: 'local', status: 400, message: '', measured: () => ({ tokens: 190_000, window: 200_000 }) })
  check('an empty message reads the same', empty?.shape === 'context-size', JSON.stringify(empty))
  let measuredWithWords = 0
  const worded = classifyOverflowFault({ family: 'local', status: 400, message: 'prompt must be a string', measured: () => { measuredWithWords++; return { tokens: 190_000, window: 200_000 } } })
  check('a worded 400 never consults the measure', worded === null && measuredWithWords === 0, JSON.stringify(worded))
  const bodiless413 = classifyOverflowFault({ family: 'local', status: 413, code: 'http-413', message: 'HTTP 413', measured: () => ({ tokens: 1_000, window: 200_000 }) })
  check('a bodiless 413 keeps the body-cap shape whatever the measure', bodiless413?.shape === 'request-too-large', JSON.stringify(bodiless413))
  const noWindow = classifyOverflowFault({ family: 'local', status: 400, message: 'HTTP 400', measured: () => ({ tokens: 190_000, window: 0 }) })
  check('an unknown window reads nothing into a bodiless 400', noWindow === null, JSON.stringify(noWindow))
  const home = getAssistantMessageFromError(new APIError(400, undefined, undefined, undefined as never), 'claude-opus-4-8')
  check('the home lane mints a bodiless 400 without a stamp (no measure at that seam)', overflowSignalOf(home) === null, JSON.stringify(home.message.content).slice(0, 120))
  const measured = near === null ? null : measureOverflow(near, [createUserMessage({ content: 'x' })], 'local/fixture-local')
  check('the ladder keeps the stamped measure instead of re-counting', measured?.measuredTokens === 102_400 && measured.measuredWindow === 128_000)
  check('the ladder\'s clause names Mercury\'s count', measured !== null && overflowWhoClause(measured).includes("by Mercury's count") && overflowWhoClause(measured).includes('102,400'), measured === null ? 'no signal' : overflowWhoClause(measured))
}

section('S4 the bodiless 400 at the REAL compat seam over the loopback')
async function callLane(model: string, messages: unknown[]): Promise<{ errors: AnyMsg[]; assistants: AnyMsg[] }> {
  const errors: AnyMsg[] = []
  const assistants: AnyMsg[] = []
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
    } as never,
  })
  for await (const ev of stream) {
    const m = ev as AnyMsg
    if (m.type !== 'assistant') continue
    assistants.push(m)
    if (m.isApiErrorMessage === true) errors.push(m)
  }
  return { errors, assistants }
}
{
  const model = 'local/fixture-local'
  fixture.script([{ error: { status: 400, body: undefined } }])
  const before = fixture.captured.length
  const small = await callLane(model, [createUserMessage({ content: 'fixture ask' })])
  check('the small request reached the wire and the wire answered 400 with no body', fixture.captured.length > before && small.errors.length > 0, `captured=${fixture.captured.length - before} errors=${small.errors.length}`)
  check('a small request\'s bodiless 400 settles as an error WITHOUT a stamp', small.errors.length > 0 && small.errors.every(m => overflowSignalOf(m as never) === null), JSON.stringify(small.errors.map(m => (m as { overflowSignal?: unknown }).overflowSignal)))
  const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
  const { localGuardWindow } = await import('../../src/services/providers/local/localCallModel.ts')
  const record = localRecordFor('local/fixture-local')
  const served = record === undefined ? undefined : localGuardWindow(record)?.tokens
  const catalogued = getContextWindowForModel(model)
  const window = served ?? catalogued
  check(`the local lane's window is known (served ${served ?? 'none'} · catalogued ${catalogued})`, window > 0)
  const filler = 'the quick brown fox jumps over the lazy dog. '.repeat(Math.ceil((window * 0.85 * 4) / 45))
  fixture.script([{ error: { status: 400, body: undefined } }])
  const sent = fixture.captured.length
  const big = await callLane(model, [createUserMessage({ content: filler })])
  check('the near-window request passed the lane\'s own fit guard and reached the wire', fixture.captured.length > sent, JSON.stringify(big.errors.map(m => JSON.stringify(m.message).slice(0, 200))))
  const stamped = big.errors.map(m => overflowSignalOf(m as never)).find(s => s !== null) ?? null
  check('a near-window request\'s bodiless 400 carries the context-size stamp', stamped?.shape === 'context-size' && stamped.family === 'local' && stamped.source === 'provider', JSON.stringify(big.errors.map(m => ({ text: JSON.stringify(m.message).slice(0, 200), sig: (m as { overflowSignal?: unknown }).overflowSignal }))))
  check('…with Mercury\'s count of the request against the window the lane holds', stamped !== null && stamped.measuredWindow === window && (stamped.measuredTokens ?? 0) >= Math.floor(window * 0.8), JSON.stringify(stamped))
  check('…and the ladder\'s clause names that count', stamped !== null && overflowWhoClause(stamped).includes("by Mercury's count"), stamped === null ? '' : overflowWhoClause(stamped))
}

section('refusals — the classifier against hostile and malformed bodies')
{
  const huge = `Input is too long for requested model. ${'x'.repeat(2_000_000)}`
  const hugeSig = classifyOverflowFault({ family: 'openai-compat', status: 400, message: huge })
  check('a 2 MB error message classifies and its detail is bounded to 240 characters', hugeSig?.shape === 'context-size' && (hugeSig.detail?.length ?? 0) <= 240, String(hugeSig?.detail?.length))
  const hostile = `${'input '.repeat(200_000)}exceeds ${'maximum '.repeat(1_000)}`
  const hostileSig = classifyOverflowFault({ family: 'openai-compat', status: 400, message: hostile })
  check('a repetitive 1.2 MB message returns a verdict (no runaway match) with a bounded detail', (hostileSig === null || hostileSig.shape === 'context-size') && (hostileSig?.detail?.length ?? 0) <= 240)
  const objectBody = mapCompatHttpFailure(400, { error: { message: { nested: 'object' } } })
  check('a body whose message is not a string still maps to words and never throws', typeof objectBody.message === 'string' && classifyOverflowFault({ family: 'openai-compat', status: 400, code: objectBody.code, message: objectBody.message }) === null, objectBody.message)
  const arrayBody = mapCompatHttpFailure(400, [{ error: { message: 'Input is too long for requested model.' } }])
  check('an array-wrapped body is read through the mapper\'s own envelope law', classifyOverflowFault({ family: 'openai-compat', status: 400, code: arrayBody.code, message: arrayBody.message })?.shape === 'context-size')
  for (const measured of [{ tokens: Number.NaN, window: 128_000 }, { tokens: -1, window: 128_000 }, { tokens: 200_000, window: Number.NaN }, { tokens: 200_000, window: -5 }, { tokens: Number.POSITIVE_INFINITY, window: 0 }]) {
    const sig = classifyOverflowFault({ family: 'local', status: 400, message: 'HTTP 400', measured: () => measured })
    check(`a measure that is not a positive pair reads nothing into a bodiless 400 (${JSON.stringify(measured)})`, sig === null, JSON.stringify(sig))
  }
  let threw = false
  try {
    classifyOverflowFault({ family: 'local', status: 400, message: 'HTTP 400', measured: () => { throw new Error('the measure failed') } })
  } catch {
    threw = true
  }
  check('a measure that throws is the caller\'s fault to see, never a silent overflow stamp', threw)
  for (const status of [400, 413, 422]) {
    check(`the per-minute allowance is refused on HTTP ${status} alike`, classifyOverflowFault({ family: 'openai-compat', status, message: 'Request too large for model on tokens per minute (TPM): Limit 6000, Requested 7000' }) === null)
  }
  const words = classifyOverflowFault({ family: 'openai-compat', status: 400, message: 'the prompt is too long to display in the dashboard; input length exceeds the maximum column width', measured: () => ({ tokens: 1, window: 1 }) })
  check('the control: a worded 400 with the window words is classified by its words alone (the measure is never read)', words !== null && words.measuredTokens === undefined && words.measuredWindow === undefined, JSON.stringify(words))
  const control = mapCompatHttpFailure(400, { error: { message: 'Invalid parameter: tool_choice must be one of auto/none', type: 'invalid_request_error' } })
  check('the control: an unrelated 400 with a body is the same plain fault it was', classifyOverflowFault({ family: 'openai-compat', status: 400, code: control.code, message: control.message }) === null && control.message === 'Invalid parameter: tool_choice must be one of auto/none')
}

await fixture.close()
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
