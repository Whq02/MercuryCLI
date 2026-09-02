#!/usr/bin/env bun
// ============================================================================
//  scripts/compact/prove-overflow-signal.ts — the context-overflow SIGNAL
//  census: every provider family's "the request does not fit" answer is
//  classified into ONE typed OverflowSignal at ONE owner, stamped by each
//  runtime's own terminal-fault seam, and read by consumers as a field —
//  never a prose sniff.
//
//    S1  the wire shapes — per family, the captured status + body runs
//        through the family's OWN HTTP failure mapping (the code-first
//        detail every runtime composes) and then the one classifier: the
//        typed shape and the numbers the sentence carries; the Anthropic
//        road through getAssistantMessageFromError (the stamp on the
//        minted message); Z.AI's documented mid-stream finish reason.
//    S2  poison controls — a 429 that mentions tokens, a credential wall,
//        a billing refusal, a server fault, an output-cap complaint
//        (max_tokens too large), an unrelated 400 that says "context":
//        NEVER an overflow.
//    S3  the stamp at the REAL runtime seams — every lane's routed call
//        over the loopback answering that family's refusal yields the
//        assistant API-error message WITH the signal (family + shape +
//        numbers), and a non-overflow refusal on the same lane yields NONE.
//    S4  the readers — overflowSignalOf reads the stamp (null on a plain
//        assistant, on a user row, on an un-stamped error); the estimate
//        constructor; the gap arithmetic; the numbers clause.
//    S5  the fold's own retry reads every family — truncateHeadForPTLRetry
//        drops by a stamped signal's gap exactly as by the home content
//        key; summarizeWithPtlRetry consults the stamp (source pin).
//
//  Run: ~/.bun/bin/bun run scripts/compact/prove-overflow-signal.ts
// ============================================================================
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
  console.log('\nTIMEOUT — overflow signal prover exceeded 180s')
  process.exit(1)
}, 180_000)
watchdog.unref?.()

// ── env hygiene BEFORE any src import ───────────────────────────────────────
delete process.env.NODE_ENV
for (const ambient of [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_SIMPLE',
  'GOOGLE_API_KEY', 'DISABLE_COMPACT', 'DISABLE_AUTO_COMPACT', 'MERCURY_OVERFLOW_RECOVERY',
]) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'overflow-signal-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'overflow-signal-daemon-'))
process.env.MERCURY_TEAMS_DIR = mkdtempSync(join(tmpdir(), 'overflow-signal-teams-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const { startOverflowFixture, OVERFLOW_LANES, OVERFLOW_WIRE_SHAPES } = await import('./overflowFixture.ts')
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)

console.log('============================================================')
console.log(' context-overflow signal — ten families, one typed verdict')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const signalMod = await import('../../src/services/api/overflowSignal.ts')
const { classifyOverflowFault, overflowSignalOf, estimateOverflowSignal, overflowGapTokens, overflowNumbersClause } = signalMod
const { mapCompatHttpFailure } = await import('../../src/services/providers/openaicompat/compatChatClient.ts')
const { mapOpenaiHttpFailure } = await import('../../src/services/providers/openai/openaiWire.ts')
const { mapZaiHttpFailure } = await import('../../src/services/providers/zai/zaiClient.ts')
const { getAssistantMessageFromError, PROMPT_TOO_LONG_ERROR_MESSAGE } = await import('../../src/services/api/errors.ts')
const { APIError } = await import('@anthropic-ai/sdk')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { createUserMessage, createAssistantMessage, createAssistantAPIErrorMessage } = await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { truncateHeadForPTLRetry } = await import('../../src/services/compact/compact.ts')

type AnyMsg = Record<string, unknown> & { type?: string }
type Sig = import('../../src/services/api/overflowSignal.ts').OverflowSignal

const families = Object.keys(OVERFLOW_WIRE_SHAPES)

// ── S1 ──────────────────────────────────────────────────────────────────────
section('S1 the wire shapes — each family\'s own failure mapping, then the one classifier')
for (const family of families) {
  const shape = OVERFLOW_WIRE_SHAPES[family]!
  let signal: Sig | null
  let code = ''
  if (family === 'anthropic') {
    const err = new APIError(shape.status, shape.body as never, undefined, undefined as never)
    const minted = getAssistantMessageFromError(err, 'claude-opus-4-8')
    signal = overflowSignalOf(minted)
    check(`${family}: the minted message keeps the stable content key`, JSON.stringify(minted.message.content).includes(PROMPT_TOO_LONG_ERROR_MESSAGE))
  } else if (family === 'openai') {
    const fault = mapOpenaiHttpFailure(shape.status, shape.body)
    code = fault.code
    signal = classifyOverflowFault({ family: 'openai', status: fault.status, code: fault.code, message: fault.message })
  } else if (family === 'zai') {
    const fault = mapZaiHttpFailure(shape.status, shape.body)
    code = fault.code
    signal = classifyOverflowFault({ family: 'zai', status: fault.status, code: fault.code, message: fault.message })
  } else {
    const fault = mapCompatHttpFailure(shape.status, shape.body)
    code = fault.code
    signal = classifyOverflowFault({ family: family as never, status: fault.status, code: fault.code, message: fault.message })
  }
  check(`${family}: classified as an overflow (${shape.expect.shape})`, signal !== null && signal.shape === shape.expect.shape, `code=${code} got=${JSON.stringify(signal)}`)
  check(`${family}: source provider · family ${family}`, signal?.source === 'provider' && signal.family === family, JSON.stringify(signal))
  if (shape.expect.actual !== undefined) {
    check(`${family}: the actual count rides (${shape.expect.actual})`, signal?.actualTokens === shape.expect.actual, String(signal?.actualTokens))
  } else {
    check(`${family}: no actual count fabricated`, signal?.actualTokens === undefined, String(signal?.actualTokens))
  }
  if (shape.expect.limit !== undefined) {
    check(`${family}: the window rides (${shape.expect.limit})`, signal?.limitTokens === shape.expect.limit, String(signal?.limitTokens))
  } else {
    check(`${family}: no window fabricated`, signal?.limitTokens === undefined, String(signal?.limitTokens))
  }
  check(`${family}: the wire's own sentence rides detail, bounded`, typeof signal?.detail === 'string' && signal.detail.length > 0 && signal.detail.length <= 240)
}
{
  // The OpenAI chat-completions sentence (the same code word, with numbers).
  const fault = mapOpenaiHttpFailure(400, { error: { message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 135000 tokens. Please reduce the length of the messages.", type: 'invalid_request_error', param: 'messages', code: 'context_length_exceeded' } })
  const signal = classifyOverflowFault({ family: 'openai', status: fault.status, code: fault.code, message: fault.message })
  check('openai (chat sentence): code word + numbers', signal?.shape === 'context-length-exceeded' && signal.actualTokens === 135_000 && signal.limitTokens === 128_000, JSON.stringify(signal))
  // The Anthropic 413 body cap.
  const err413 = new APIError(413, { type: 'error', error: { type: 'request_too_large', message: 'Request entity too large' } } as never, undefined, undefined as never)
  const minted413 = getAssistantMessageFromError(err413, 'claude-opus-4-8')
  check('anthropic 413: the body cap is its own overflow shape', overflowSignalOf(minted413)?.shape === 'request-too-large', JSON.stringify(overflowSignalOf(minted413)))
  // Z.AI's documented mid-stream finish reason.
  const zaiFinish = classifyOverflowFault({ family: 'zai', code: 'finish:model_context_window_exceeded', message: 'stream terminated by the provider: model_context_window_exceeded' })
  check('zai finish reason model_context_window_exceeded → context-window-exceeded', zaiFinish?.shape === 'context-window-exceeded' && zaiFinish.family === 'zai', JSON.stringify(zaiFinish))
  // LM Studio's context-length overflow sentence on the local lane.
  const lm = mapCompatHttpFailure(400, { error: 'Trying to keep the first 4097 tokens when context the overflows. However, the model is loaded with context length of only 4096 tokens, which is not enough. Try to load the model with a larger context length, or provide a shorter input.' })
  const lmSig = classifyOverflowFault({ family: 'local', status: lm.status, code: lm.code, message: lm.message })
  check('local (LM Studio sentence): context-size with the loaded window', lmSig?.shape === 'context-size' && lmSig.limitTokens === 4096, JSON.stringify(lmSig))
  // A gateway stranger on the home transport speaking the compat sentence.
  const gw = new APIError(400, { error: { message: "This model's maximum context length is 65536 tokens. However, you requested 70000 tokens (69000 in the messages, 1000 in the completion)." } } as never, undefined, undefined as never)
  const mintedGw = getAssistantMessageFromError(gw, 'stranger/gateway-model')
  const gwSig = overflowSignalOf(mintedGw)
  check('home-lane gateway stranger: the generic tail stamps the compat sentence (family unknown)', gwSig?.shape === 'context-length-exceeded' && gwSig.family === 'unknown' && gwSig.actualTokens === 70_000, JSON.stringify(gwSig))
}

// ── S2 ──────────────────────────────────────────────────────────────────────
section('S2 poison controls — refusals that mention tokens or context and are NOT overflows')
{
  const poisons: Array<{ label: string; family: string; status?: number; code?: string; message: string }> = [
    { label: 'openai 429 tokens-per-minute', family: 'openai', status: 429, code: 'openai-rate_limit_exceeded', message: 'Rate limit reached for gpt-5.6-sol on tokens per min (TPM): Limit 30000, Used 29000, Requested 5000. Please try again in 2s.' },
    { label: 'anthropic 401', family: 'anthropic', status: 401, message: '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' },
    { label: 'compat 402 balance', family: 'deepseek', status: 402, code: 'http-402', message: 'Insufficient Balance' },
    { label: 'compat 503 overloaded', family: 'openrouter', status: 503, code: 'http-503', message: 'The model is overloaded; the context length is not the issue' },
    { label: 'openai max_tokens too large (output cap)', family: 'openai', status: 400, code: 'openai-invalid_value', message: 'max_tokens is too large: 200000. This model supports at most 128000 completion tokens, whereas you provided 200000.' },
    { label: 'anthropic output cap', family: 'anthropic', status: 400, message: 'max_tokens: 100000 > 64000, which is the maximum allowed number of output tokens for claude-opus-4-8' },
    { label: 'anthropic role alternation', family: 'anthropic', status: 400, message: 'messages: roles must alternate between "user" and "assistant", but found multiple "user" roles in a row' },
    { label: 'unrelated 400 that says context', family: 'gemini', status: 400, code: 'api-INVALID_ARGUMENT', message: 'Invalid parameter: context_management is not supported by this model' },
    { label: 'zai 1211 unknown model', family: 'zai', status: 400, code: 'zai-1211', message: 'Unknown Model, please check the model code' },
    { label: 'transport fetch-failed', family: 'local', code: 'fetch-failed', message: 'connect ECONNREFUSED 127.0.0.1:9 (endpoint 127.0.0.1:9)' },
  ]
  for (const p of poisons) {
    const sig = classifyOverflowFault({ family: p.family as never, status: p.status, code: p.code, message: p.message })
    check(`${p.label} → null`, sig === null, JSON.stringify(sig))
  }
  const rate = new APIError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'This request would exceed your organization\'s rate limit of 400,000 input tokens per minute' } } as never, undefined, undefined as never)
  check('anthropic 429 input-tokens-per-minute: minted without a stamp', overflowSignalOf(getAssistantMessageFromError(rate, 'claude-opus-4-8')) === null)
}

// ── S3 ──────────────────────────────────────────────────────────────────────
section('S3 the stamp at the REAL runtime seams — every lane over the loopback')
async function callLane(model: string): Promise<{ errors: AnyMsg[]; assistants: AnyMsg[] }> {
  const errors: AnyMsg[] = []
  const assistants: AnyMsg[] = []
  const stream = routedCallModel({
    messages: [createUserMessage({ content: 'fixture ask' })] as never,
    systemPrompt: asSystemPrompt(['fixture system prompt']),
    thinkingConfig: { type: 'disabled' },
    tools: [] as never,
    signal: AbortSignal.timeout(20_000),
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
const NON_OVERFLOW_400: Record<string, { status: number; body: unknown }> = {
  anthropic: { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'messages: roles must alternate between "user" and "assistant"' } } },
  responses: { status: 400, body: { error: { message: 'Unsupported parameter: temperature', type: 'invalid_request_error', param: 'temperature', code: 'unsupported_parameter' } } },
  chat: { status: 400, body: { error: { message: 'Invalid parameter: tool_choice must be one of auto/none', type: 'invalid_request_error' } } },
}
for (const { lane, model, dialect } of OVERFLOW_LANES) {
  const shape = OVERFLOW_WIRE_SHAPES[lane]!
  fixture.script([{ error: { status: shape.status, body: shape.body } }])
  const before = fixture.captured.length
  const r = await callLane(model)
  const reached = fixture.captured.length > before
  check(`${lane}: the routed call reached the ${dialect} wire`, reached, `captured=${fixture.captured.length - before}`)
  const stamped = r.errors.map(m => overflowSignalOf(m as never)).find(s => s !== null) ?? null
  check(`${lane}: the runtime's API-error message carries the signal`, stamped !== null, JSON.stringify(r.errors.map(m => ({ text: JSON.stringify(m.message).slice(0, 160), sig: (m as { overflowSignal?: unknown }).overflowSignal }))))
  check(`${lane}: family + shape on the stamp`, stamped?.family === lane && stamped.shape === shape.expect.shape, JSON.stringify(stamped))
  if (shape.expect.actual !== undefined) check(`${lane}: numbers on the stamp`, stamped?.actualTokens === shape.expect.actual && stamped.limitTokens === shape.expect.limit, JSON.stringify(stamped))
  // The poison on the same lane: a bad request that is not an overflow.
  const poison = NON_OVERFLOW_400[dialect]!
  fixture.script([{ error: { status: poison.status, body: poison.body } }])
  const p = await callLane(model)
  check(`${lane}: a non-overflow refusal yields an error WITHOUT a stamp`, p.errors.length > 0 && p.errors.every(m => overflowSignalOf(m as never) === null), JSON.stringify(p.errors.map(m => (m as { overflowSignal?: unknown }).overflowSignal)))
}
{
  // Z.AI's mid-stream channel through the real runtime: content settles,
  // the documented finish reason follows, the after-settle fault carries
  // the stamp (the turn machine's ladder takes it before the stream-fault
  // band).
  fixture.script([{ text: 'partial answer before the window ran out', finishReason: 'model_context_window_exceeded' }])
  const r = await callLane('glm-5.2')
  const stamped = r.errors.map(m => overflowSignalOf(m as never)).find(s => s !== null) ?? null
  check('zai mid-stream finish reason: the after-settle fault carries the stamp', stamped?.shape === 'context-window-exceeded' && stamped.family === 'zai', JSON.stringify(r.errors.map(m => JSON.stringify(m.message).slice(0, 200))))
  check('zai mid-stream: the partial content still settled beside it', r.assistants.some(m => m.isApiErrorMessage !== true && JSON.stringify(m.message).includes('partial answer')))
}

// ── S4 ──────────────────────────────────────────────────────────────────────
section('S4 the readers — the stamp is the one field consumers read')
{
  const plain = createAssistantMessage({ content: 'a fine reply' })
  check('a plain assistant reads null', overflowSignalOf(plain) === null)
  check('a user row reads null', overflowSignalOf(createUserMessage({ content: 'hi' })) === null)
  const bare = createAssistantAPIErrorMessage({ content: 'API Error: something else', error: 'unknown' })
  check('an un-stamped API error reads null', overflowSignalOf(bare) === null)
  const sig: Sig = { source: 'provider', family: 'openai', shape: 'context-length-exceeded', actualTokens: 135_000, limitTokens: 128_000 }
  const stamped = createAssistantAPIErrorMessage({ content: 'API Error: x', error: 'invalid_request', overflow: sig })
  check('a stamped API error reads its signal by reference', overflowSignalOf(stamped) === sig)
  const nullStamp = createAssistantAPIErrorMessage({ content: 'API Error: x', error: 'invalid_request', overflow: null })
  check('a null classifier answer leaves no field behind', !('overflowSignal' in nullStamp) && overflowSignalOf(nullStamp) === null)
  const est = estimateOverflowSignal({ family: 'anthropic', actualTokens: 131_000, limitTokens: 128_000 })
  check('the estimate constructor: source estimate · blocking-limit · numbers', est.source === 'estimate' && est.shape === 'blocking-limit' && est.actualTokens === 131_000 && est.limitTokens === 128_000)
  check('the gap: actual − limit when both are known', overflowGapTokens(sig) === 7_000 && overflowGapTokens(est) === 3_000)
  check('the gap: undefined when a number is missing', overflowGapTokens({ source: 'provider', family: 'openai', shape: 'context-length-exceeded' }) === undefined)
  check('the gap: undefined when the request was not over', overflowGapTokens({ source: 'provider', family: 'openai', shape: 'context-length-exceeded', actualTokens: 10, limitTokens: 20 }) === undefined)
  check('the numbers clause: both → "N tokens > M"', overflowNumbersClause(sig) === '135,000 tokens > 128,000', overflowNumbersClause(sig))
  check('the numbers clause: limit only → "over the M-token window"', overflowNumbersClause({ source: 'provider', family: 'moonshot', shape: 'token-limit', limitTokens: 262_144 }) === 'over the 262,144-token window')
  check('the numbers clause: none → undefined', overflowNumbersClause({ source: 'provider', family: 'openai', shape: 'context-length-exceeded' }) === undefined)
}

// ── S5 ──────────────────────────────────────────────────────────────────────
section('S5 the fold\'s own retry reads every family — truncation by a stamped gap')
{
  const round = (i: number): unknown[] => [
    createUserMessage({ content: `ask ${i} ${'x'.repeat(400)}` }),
    { type: 'assistant', uuid: `00000000-0000-4000-a000-0000000000${String(10 + i)}`, requestId: `r${i}`, message: { id: `msg_${i}`, type: 'message', role: 'assistant', model: 'fixture', content: [{ type: 'text', text: `reply ${i} ${'y'.repeat(400)}` }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 50 } } },
  ]
  const messages = [...round(0), ...round(1), ...round(2), ...round(3), ...round(4)]
  // A stamped OpenRouter refusal with a gap of ~one round (~270 tokens per
  // round at the 4/3 estimate): the retry drops as many leading groups as
  // the gap needs — the same arithmetic the home content key drives.
  const stamped = createAssistantAPIErrorMessage({
    content: 'API Error: OpenRouter stream failed (http-400) — This endpoint\'s maximum context length is 1000 tokens. However, you requested about 1250 tokens',
    error: 'invalid_request',
    overflow: { source: 'provider', family: 'openrouter', shape: 'context-length-exceeded', actualTokens: 1250, limitTokens: 1000 },
  })
  const truncated = truncateHeadForPTLRetry(messages as never, stamped)
  check('a stamped signal drives the truncation (fewer messages survive)', truncated !== null && truncated.length < messages.length, `${truncated?.length}/${messages.length}`)
  const home = createAssistantAPIErrorMessage({ content: `${PROMPT_TOO_LONG_ERROR_MESSAGE}: 1250 tokens > 1000 maximum`, error: 'invalid_request', errorDetails: 'prompt is too long: 1250 tokens > 1000 maximum' })
  const truncatedHome = truncateHeadForPTLRetry(messages as never, home)
  check('…by exactly the drop the home content key would make', truncated !== null && truncatedHome !== null && truncated.length === truncatedHome.length, `${truncated?.length} vs ${truncatedHome?.length}`)
  const unknownGap = createAssistantAPIErrorMessage({ content: 'API Error: OpenAI stream failed (openai-context_length_exceeded) — Your input exceeds the context window of this model.', error: 'invalid_request', overflow: { source: 'provider', family: 'openai', shape: 'context-length-exceeded' } })
  const truncatedUnknown = truncateHeadForPTLRetry(messages as never, unknownGap)
  check(
    'an unknown gap falls to the proportional drop (the head round is gone)',
    truncatedUnknown !== null && !truncatedUnknown.includes(messages[0] as never) && truncatedUnknown.length <= messages.length,
    `${truncatedUnknown?.length}`,
  )
  const src = readFileSync(join(ROOT, 'src/services/compact/compact.ts'), 'utf8')
  const retryBody = src.slice(src.indexOf('async function summarizeWithPtlRetry'), src.indexOf('function validateSummary'))
  check('source pin: summarizeWithPtlRetry consults overflowSignalOf beside the content key', retryBody.includes('overflowSignalOf(response) === null') && retryBody.includes('PROMPT_TOO_LONG_ERROR_MESSAGE'))
}

await fixture.close()
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
