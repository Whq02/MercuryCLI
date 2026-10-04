#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — fold-in-parts prover exceeded 240s')
  process.exit(1)
}, 240_000)
watchdog.unref?.()

delete process.env.NODE_ENV
for (const ambient of [
  'ANTHROPIC_API_KEY', 'MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE',
  'GOOGLE_API_KEY', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_OVERFLOW_RECOVERY', 'MERCURY_BLOCKING_LIMIT_OVERRIDE',
  'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_COMPACT_KEEP_TAIL',
]) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fold-in-parts-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'fold-in-parts-daemon-'))
process.env.MERCURY_CREWS_DIR = mkdtempSync(join(tmpdir(), 'fold-in-parts-crews-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const { startOverflowFixture, OVERFLOW_WIRE_SHAPES } = await import('./overflowFixture.ts')
type Captured = import('./overflowFixture.ts').Captured
type Turn = import('./overflowFixture.ts').Turn
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { query } = await import('../../src/query.ts')
const { productionDeps } = await import('../../src/query/deps.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { ERROR_MESSAGE_PROMPT_TOO_LONG } = await import('../../src/services/compact/compact.ts')

type AnyMsg = Record<string, unknown> & { type?: string }
const textOf = (m: unknown): string => {
  const msg = m as AnyMsg
  const c = (msg.message as { content?: unknown } | undefined)?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return (c as AnyMsg[]).filter(b => b.type === 'text').map(b => String(b.text ?? '')).join('\n')
  if (typeof msg.content === 'string') return msg.content
  return ''
}

function makeCtx(model: string): Record<string, unknown> {
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      tools: [],
      engineModel: model,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      debug: false,
      verbose: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState: () => appState,
    setAppState: (f: (prev: never) => never): void => {
      appState = f(appState as never) as unknown as Record<string, unknown>
    },
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId: undefined,
  }
}

const OPERATOR_ASK = 'operator ask: land the change and run its checks'
function seed(rounds: number, replyChars = 0): unknown[] {
  const out: unknown[] = []
  for (let i = 0; i < rounds; i++) {
    out.push(createUserMessage({ content: `ask ${i}: adjust module ${i}` }))
    out.push({
      type: 'assistant',
      uuid: `00000000-0000-4000-a000-0000000000${String(10 + i)}`,
      timestamp: new Date().toISOString(),
      requestId: `req_${i}`,
      message: {
        id: `msg_${i}`,
        type: 'message',
        role: 'assistant',
        model: 'fixture',
        content: [{ type: 'text', text: replyChars > 0 ? `reply ${i}: ${`module ${i} adjusted line ${'x'.repeat(40)}\n`.repeat(Math.ceil(replyChars / 60))}` : `reply ${i}: module ${i} adjusted ${'and its checks pass '.repeat(20)}` }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 900 + i, output_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    })
  }
  out.push(createUserMessage({ content: OPERATOR_ASK }))
  return out
}

type Drive = { yields: AnyMsg[]; terminal: Record<string, unknown>; threw: string | undefined; wire: Captured[] }
async function drive(model: string, messages: AnyMsg[]): Promise<Drive> {
  const before = fixture.captured.length
  const deps = productionDeps()
  const yields: AnyMsg[] = []
  let terminal: Record<string, unknown> = {}
  let threw: string | undefined
  try {
    const gen = query({
      messages: messages as never,
      systemPrompt: ['fixture system prompt'] as never,
      userContext: {},
      systemContext: {},
      canUseTool: (async () => ({ behavior: 'deny', message: 'no tools in this rig' })) as never,
      toolUseContext: makeCtx(model) as never,
      querySource: 'sdk' as never,
      deps,
    })
    let r = await gen.next()
    while (!r.done) {
      yields.push(r.value as AnyMsg)
      r = await gen.next()
    }
    terminal = r.value as Record<string, unknown>
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  await new Promise(resolve => setTimeout(resolve, 5))
  return { yields, terminal, threw, wire: fixture.captured.slice(before) }
}

const wireText = (body: Record<string, unknown>): string => JSON.stringify(body)
const lastAssistantText = (yields: AnyMsg[]): string => textOf(yields.filter(y => y.type === 'assistant').at(-1))
const errorTexts = (yields: AnyMsg[]): string[] => yields.filter(y => y.type === 'assistant' && y.isApiErrorMessage === true).map(textOf)
const messagesChars = (body: Record<string, unknown>): number => JSON.stringify(((body.messages as unknown[] | undefined) ?? []).slice(0, -1)).length
const lastUserTextOf = (body: Record<string, unknown>): string => {
  const rows = (body.messages as Array<{ content?: unknown }> | undefined) ?? []
  const last = rows.at(-1)?.content
  return typeof last === 'string' ? last : Array.isArray(last) ? (last as Array<{ text?: string }>).map(b => b.text ?? '').join('') : ''
}
const isSummaryCall = (body: Record<string, unknown>): boolean => !lastUserTextOf(body).includes(OPERATOR_ASK)

function windowServer(limitChars: number, numbers: boolean): (request: Captured) => Turn {
  let parts = 0
  return request => {
    const size = messagesChars(request.body)
    if (size > limitChars) {
      const shape = OVERFLOW_WIRE_SHAPES.anthropic!
      const message = numbers ? `prompt is too long: ${Math.round(size / 4)} tokens > ${Math.round(limitChars / 4)} maximum` : 'prompt is too long'
      return { error: { status: shape.status, body: { type: 'error', error: { type: 'invalid_request_error', message } } } }
    }
    const rows = (request.body.messages as Array<{ content?: unknown }> | undefined) ?? []
    const last = rows.at(-1)?.content
    const lastText = typeof last === 'string' ? last : Array.isArray(last) ? (last as Array<{ text?: string }>).map(b => b.text ?? '').join('') : ''
    if (!lastText.includes(OPERATOR_ASK)) {
      parts += 1
      const asks = [...wireText(request.body).matchAll(/ask (\d+): adjust module/g)].map(m => m[1])
      return { text: `SUMMARY ${parts}: asks ${asks.join(',')} folded` }
    }
    return { text: 'the recovered answer', usage: { input: 600, output: 10 } }
  }
}

section('P1 a session far over the window with no numbers in the refusal: the base gave up after three narrowing retries; the tip folds it in parts and lands')
{
  const forty = seed(40, 1_500) as AnyMsg[]
  fixture.script(windowServer(20_000, false))
  const r = await drive('claude-opus-4-8', forty)
  check('the run completed (red on the base: terminal prompt_too_long)', r.threw === undefined && r.terminal.reason === 'completed', `threw=${r.threw ?? 'no'} terminal=${JSON.stringify(r.terminal)} errors=${JSON.stringify(errorTexts(r.yields)).slice(0, 200)}`)
  const summaryCalls = r.wire.filter(w => isSummaryCall(w.body) && messagesChars(w.body) <= 20_000)
  const seen = new Set<string>()
  for (const w of summaryCalls) for (const m of wireText(w.body).matchAll(/ask (\d+): adjust module/g)) seen.add(m[1]!)
  check('every round reached a summary call that fit the window — nothing was dropped on the floor', [...Array(40).keys()].every(i => seen.has(String(i))), `asks seen: ${[...seen].sort((a, b) => Number(a) - Number(b)).join(',')}`)
  check('the fold ran in parts: more than one summary call fit the window', summaryCalls.length >= 2, String(summaryCalls.length))
  const final = summaryCalls.at(-1)
  check('the final summary call opens on a part capsule', final !== undefined && wireText(final.body).includes('earlier turns folded into this summary for the compaction') && /SUMMARY \d+:/.test(wireText(final.body)), final !== undefined ? wireText(final.body).slice(0, 200) : 'no final call')
  check('the reply settled last', lastAssistantText(r.yields) === 'the recovered answer', lastAssistantText(r.yields))
  check('no refusal row reached the transcript', errorTexts(r.yields).length === 0, JSON.stringify(errorTexts(r.yields)))
}

section('P2 the refusal names the numbers: the base landed in one retry by DROPPING the oldest rounds unsummarised; the tip summarises them')
{
  const forty = seed(40, 1_500) as AnyMsg[]
  fixture.script(windowServer(25_000, true))
  const r = await drive('claude-opus-4-8', forty)
  check('the run completed', r.threw === undefined && r.terminal.reason === 'completed', `threw=${r.threw ?? 'no'} terminal=${JSON.stringify(r.terminal)}`)
  const summaryCalls = r.wire.filter(w => isSummaryCall(w.body) && messagesChars(w.body) <= 25_000)
  const seen = new Set<string>()
  for (const w of summaryCalls) for (const m of wireText(w.body).matchAll(/ask (\d+): adjust module/g)) seen.add(m[1]!)
  check('the oldest rounds were summarised, not dropped (red on the base: ask 0 never reached any summary call)', seen.has('0') && seen.has('1'), `asks seen: ${[...seen].sort((a, b) => Number(a) - Number(b)).join(',')}`)
  check('every round reached a summary call', [...Array(40).keys()].every(i => seen.has(String(i))), `asks seen: ${[...seen].sort((a, b) => Number(a) - Number(b)).join(',')}`)
  check('the reply settled last', lastAssistantText(r.yields) === 'the recovered answer', lastAssistantText(r.yields))
}

section('P3 one round alone is bigger than the window: the base could shed nothing and failed; the tip folds the round as text in parts')
{
  const one = seed(1, 90_000) as AnyMsg[]
  fixture.script(windowServer(60_000, true))
  const r = await drive('claude-opus-4-8', one)
  check('the run completed (red on the base: terminal prompt_too_long)', r.threw === undefined && r.terminal.reason === 'completed', `threw=${r.threw ?? 'no'} terminal=${JSON.stringify(r.terminal)} errors=${JSON.stringify(errorTexts(r.yields)).slice(0, 200)}`)
  const chunkCalls = r.wire.filter(w => isSummaryCall(w.body) && messagesChars(w.body) <= 60_000 && wireText(w.body).includes('module 0 adjusted line'))
  check('the round went to the summariser as text, in more than one chunk that fit', chunkCalls.length >= 2, String(chunkCalls.length))
  check('the reply settled last', lastAssistantText(r.yields) === 'the recovered answer', lastAssistantText(r.yields))
}

section('P4 a provider that refuses even the smallest part: the fold gives up with the typed refusal, never a runaway loop')
{
  const three = seed(3) as AnyMsg[]
  const shape = OVERFLOW_WIRE_SHAPES.anthropic!
  let requests = 0
  fixture.script(() => {
    requests += 1
    return { error: { status: shape.status, body: shape.body } }
  })
  const r = await drive('claude-opus-4-8', three)
  check('terminal prompt_too_long, the run never threw', r.threw === undefined && r.terminal.reason === 'prompt_too_long', `threw=${r.threw ?? 'no'} terminal=${JSON.stringify(r.terminal)}`)
  check('the refusal names the fold\'s own reason: refused even for its smallest part', errorTexts(r.yields).some(text => text.includes(ERROR_MESSAGE_PROMPT_TOO_LONG)), JSON.stringify(errorTexts(r.yields)).slice(0, 300))
  check('the ladder walked down and stopped (a bounded number of requests)', requests >= 3 && requests <= 12, String(requests))
}

section('P5 ONE plain warning when a request fails for a reason the wire did not call an overflow while the conversation is near the window')
{
  const { saveGlobalConfig } = await import('../../src/utils/config.ts')
  saveGlobalConfig(config => ({ ...config, autoCompactWindow: 100_000 }))
  process.env.MERCURY_AUTO_COMPACT = '0'
  process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE = '1000000'
  const big = seed(40, 3_000) as AnyMsg[]
  const lastReply = big.filter(m => m.type === 'assistant').at(-1) as { message: { usage: { input_tokens: number } } }
  lastReply.message.usage.input_tokens = 90_000
  const refusal = { error: { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'the request was not accepted' } } } } as const
  fixture.script([refusal])
  const r = await drive('claude-opus-4-8', big)
  const noticesOf = (yields: AnyMsg[]): string[] => yields.filter(y => y.type === 'system').map(y => String((y as { content?: unknown }).content ?? ''))
  const warnings = noticesOf(r.yields).filter(text => text.includes('this conversation is near the window'))
  check('the failed request ends the turn (no overflow was named, so no fold ran)', r.threw === undefined && r.terminal.reason === 'completed' && errorTexts(r.yields).length === 1 && r.wire.length === 1, `terminal=${JSON.stringify(r.terminal)} errors=${errorTexts(r.yields).length} wire=${r.wire.length}`)
  check('ONE plain warning names the cause (the size against the window) and what happens next (red on the base: the error row alone)', warnings.length === 1 && /about [\d,]+ of the model's 100,000-token window/.test(warnings[0] ?? '') && /\/compact folds it by hand/.test(warnings[0] ?? ''), JSON.stringify(noticesOf(r.yields)).slice(0, 400))
  fixture.script([refusal])
  const small = await drive('claude-opus-4-8', seed(3, 200) as AnyMsg[])
  check('a small conversation whose request fails gets no size warning', noticesOf(small.yields).every(text => !text.includes('near the window')), JSON.stringify(noticesOf(small.yields)).slice(0, 300))
  delete process.env.MERCURY_AUTO_COMPACT
  delete process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE
  saveGlobalConfig(config => { const next = { ...config }; delete (next as { autoCompactWindow?: number }).autoCompactWindow; return next })
}

await fixture.close()
console.log(`\n${failures === 0 ? '✅' : '❌'} prove-fold-in-parts — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
