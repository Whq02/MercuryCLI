#!/usr/bin/env bun
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
  console.log('\nTIMEOUT — overflow real-fold prover exceeded 240s')
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
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'overflow-real-fold-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'overflow-real-fold-daemon-'))
process.env.MERCURY_CREWS_DIR = mkdtempSync(join(tmpdir(), 'overflow-real-fold-crews-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const { startOverflowFixture, OVERFLOW_WIRE_SHAPES } = await import('./overflowFixture.ts')
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)

console.log('============================================================')
console.log(' context-overflow recovery — the real fold over the loopback')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { query } = await import('../../src/query.ts')
const { productionDeps } = await import('../../src/query/deps.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { contextFill } = await import('../../src/utils/tokens.ts')
const { ERROR_MESSAGE_PROMPT_TOO_LONG } = await import('../../src/services/compact/compact.ts')
const { PROMPT_TOO_LONG_ERROR_MESSAGE } = await import('../../src/services/api/errors.ts')

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
function seed(rounds: number): unknown[] {
  const out: unknown[] = []
  for (let i = 0; i < rounds; i++) {
    out.push(createUserMessage({ content: `ask ${i}: adjust module ${i} ${'and keep the notes tidy '.repeat(20)}` }))
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
        content: [{ type: 'text', text: `reply ${i}: module ${i} adjusted ${'and its checks pass '.repeat(20)}` }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 900 + i, output_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    })
  }
  out.push(createUserMessage({ content: OPERATOR_ASK }))
  return out
}

type Drive = { yields: AnyMsg[]; terminal: Record<string, unknown>; threw: string | undefined; wire: ReturnType<typeof fixture.captured.slice> }
async function drive(model: string, rounds: number, inputTokens?: number, prior?: AnyMsg[]): Promise<Drive> {
  const messages = prior ?? seed(rounds) as AnyMsg[]
  if (inputTokens !== undefined) {
    const last = messages.filter(m => m.type === 'assistant').at(-1)!
    const payload = last.message as { usage: { input_tokens: number } }
    payload.usage.input_tokens = inputTokens
  }
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

const boundaryOf = (yields: AnyMsg[]): AnyMsg | undefined => yields.find(y => y.type === 'system' && (y as { subtype?: string }).subtype === 'compact_boundary')
const lastAssistantText = (yields: AnyMsg[]): string => textOf(yields.filter(y => y.type === 'assistant').at(-1))
const errorTexts = (yields: AnyMsg[]): string[] => yields.filter(y => y.type === 'assistant' && y.isApiErrorMessage === true).map(textOf)
function wireLastUserText(dialect: string, body: Record<string, unknown>): string {
  if (dialect === 'responses') {
    const input = (body.input as AnyMsg[] | undefined) ?? []
    const last = input.at(-1)
    const c = last?.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) return (c as AnyMsg[]).map(p => String(p.text ?? '')).join('')
    return ''
  }
  const messages = (body.messages as AnyMsg[] | undefined) ?? []
  const last = messages.at(-1)
  const c = last?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return (c as AnyMsg[]).filter(b => b.type === 'text').map(b => String(b.text ?? '')).join('')
  return ''
}
const wireMessageCount = (dialect: string, body: Record<string, unknown>): number =>
  dialect === 'responses' ? ((body.input as unknown[] | undefined) ?? []).length : ((body.messages as unknown[] | undefined) ?? []).length
const wireText = (body: Record<string, unknown>): string => JSON.stringify(body)

section('F1 the home lane — overflow → the real fold → the retry → a reply')
{
  const shape = OVERFLOW_WIRE_SHAPES.anthropic!
  fixture.script([
    { error: { status: shape.status, body: shape.body } },
    { text: 'SUMMARY: the earlier modules were adjusted and their checks pass; the operator now asks to land the change and run its checks.' },
    { text: 'the recovered answer', usage: { input: 640, output: 12 } },
  ])
  const r = await drive('claude-opus-4-8', 5)
  check('the run completed without throwing', r.threw === undefined && r.terminal.reason === 'completed', `threw=${r.threw ?? 'no'} terminal=${JSON.stringify(r.terminal)}`)
  check('three requests reached the wire: the overflow, the summary call, the retry', r.wire.length === 3 && r.wire.every(w => w.dialect === 'anthropic'), `${r.wire.length} ${JSON.stringify(r.wire.map(w => w.dialect))}`)
  check('the summary call carried the fold prompt', r.wire[1] !== undefined && /summar/i.test(wireText(r.wire[1].body)))
  const retry = r.wire[2]
  check('the retried request ends with the operator message VERBATIM', retry !== undefined && wireLastUserText('anthropic', retry.body).endsWith(OPERATOR_ASK), retry !== undefined ? wireLastUserText('anthropic', retry.body).slice(-80) : 'no retry')
  check('the retried request opens on the summary, not the folded history', retry !== undefined && wireText(retry.body).includes('SUMMARY: the earlier modules') && !wireText(retry.body).includes('reply 0: module 0 adjusted'))
  const boundary = boundaryOf(r.yields)
  const meta = (boundary as { compactMetadata?: { trigger?: string; overflow?: { family?: string; shape?: string; actualTokens?: number }; preTokens?: number } } | undefined)?.compactMetadata
  check("the REAL compact_boundary row yields, typed 'overflow'", meta?.trigger === 'overflow', JSON.stringify(meta))
  check('…carrying the signal (anthropic · prompt-too-long · 213462) and the folded weight', meta?.overflow?.family === 'anthropic' && meta.overflow.shape === 'prompt-too-long' && meta.overflow.actualTokens === 213_462 && typeof meta.preTokens === 'number' && meta.preTokens > 0, JSON.stringify(meta))
  check('the summary row yields (isCompactSummary)', r.yields.some(y => y.type === 'user' && (y as { isCompactSummary?: boolean }).isCompactSummary === true))
  check('the last settled assistant is the reply', lastAssistantText(r.yields) === 'the recovered answer', lastAssistantText(r.yields))
  check('no API-error row ever yields (the refusal was withheld and recovered)', errorTexts(r.yields).length === 0, JSON.stringify(errorTexts(r.yields)))
  check('the notice speaks', r.yields.some(y => y.type === 'system' && String(y.content ?? '').includes('context overflowed (Anthropic: 213,462 tokens > 200,000) — folding the conversation and retrying')))
  const transcript = [...seed(5), ...r.yields.filter(y => y.type === 'user' || y.type === 'assistant' || y.type === 'system')]
  const fill = contextFill(transcript as never)
  check('the gauge after the recovery anchors on the retried turn\'s usage (source usage, the fixture\'s 640+12)', fill.source === 'usage' && fill.tokens === 652, JSON.stringify(fill))
}

section('F2 a chat-completions family (OpenRouter via the compat runtime)')
{
  const shape = OVERFLOW_WIRE_SHAPES.openrouter!
  fixture.script([
    { error: { status: shape.status, body: shape.body } },
    { text: 'SUMMARY: modules adjusted; the operator asks to land the change.' },
    { text: 'the openrouter recovered answer', usage: { input: 500, output: 9 } },
  ])
  const r = await drive('openrouter/fixture/model', 5)
  check('the run completed', r.threw === undefined && r.terminal.reason === 'completed', `threw=${r.threw ?? 'no'} terminal=${JSON.stringify(r.terminal)}`)
  check('three chat requests reached the wire', r.wire.length === 3 && r.wire.every(w => w.dialect === 'chat'), `${r.wire.length} ${JSON.stringify(r.wire.map(w => w.dialect))}`)
  const retry = r.wire[2]
  check('the retried request ends with the operator message VERBATIM', retry !== undefined && wireLastUserText('chat', retry.body) === OPERATOR_ASK, retry !== undefined ? wireLastUserText('chat', retry.body).slice(0, 80) : 'no retry')
  const meta = (boundaryOf(r.yields) as { compactMetadata?: { trigger?: string; overflow?: { family?: string; actualTokens?: number; limitTokens?: number } } } | undefined)?.compactMetadata
  check("the boundary is typed 'overflow' with OpenRouter's own numbers", meta?.trigger === 'overflow' && meta.overflow?.family === 'openrouter' && meta.overflow.actualTokens === 140_000 && meta.overflow.limitTokens === 131_072, JSON.stringify(meta))
  check('the reply settled last; no error row yields', lastAssistantText(r.yields) === 'the openrouter recovered answer' && errorTexts(r.yields).length === 0)
  check('the notice names the family and the numbers', r.yields.some(y => y.type === 'system' && String(y.content ?? '').includes('context overflowed (OpenRouter: 140,000 tokens > 131,072) — folding the conversation and retrying')))
}

section('F3 the fold itself overflows — the shed head is folded into a part summary first, then the whole lands (red on the base: the head was dropped, four requests)')
{
  const shape = OVERFLOW_WIRE_SHAPES.anthropic!
  fixture.script([
    { error: { status: shape.status, body: shape.body } },
    { error: { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 201000 tokens > 200000 maximum' } } } },
    { text: 'PART SUMMARY: module 0 was adjusted first.' },
    { text: 'SUMMARY after the fold in parts: the later modules were adjusted; the operator asks to land the change.' },
    { text: 'recovered after a fold in parts', usage: { input: 300, output: 8 } },
  ])
  const r = await drive('claude-opus-4-8', 6)
  check('the run completed', r.threw === undefined && r.terminal.reason === 'completed', `threw=${r.threw ?? 'no'} terminal=${JSON.stringify(r.terminal)}`)
  check('five requests: overflow · summary (refused) · the shed head\'s own summary · the whole (part capsule + the rest) · retry', r.wire.length === 5, String(r.wire.length))
  const first = r.wire[1]
  const part = r.wire[2]
  const whole = r.wire[3]
  check('the first summary call carried the whole head', first !== undefined && wireText(first.body).includes('ask 0: adjust module 0'))
  check('the shed head is summarised on its own, not dropped: the part call carries the oldest round and nothing later', part !== undefined && wireText(part.body).includes('ask 0: adjust module 0') && !wireText(part.body).includes('reply 5: module 5 adjusted'), part !== undefined ? `${wireMessageCount('anthropic', part.body)} messages` : 'no part call')
  check('the whole call opens on the part capsule and keeps the rest (the oldest round lives in the capsule)', whole !== undefined && wireText(whole.body).includes('earlier turns folded into this summary for the compaction') && wireText(whole.body).includes('PART SUMMARY: module 0 was adjusted first.') && !wireText(whole.body).includes('ask 0: adjust module 0') && wireText(whole.body).includes('reply 5: module 5 adjusted'), whole !== undefined ? `${wireMessageCount('anthropic', whole.body)} messages` : 'no whole call')
  check('the reply settled last', lastAssistantText(r.yields) === 'recovered after a fold in parts', lastAssistantText(r.yields))
  check("the boundary is typed 'overflow'", (boundaryOf(r.yields) as { compactMetadata?: { trigger?: string } } | undefined)?.compactMetadata?.trigger === 'overflow')
}

section('F4 the fold cannot shrink under the window — the ladder walks every part down to its floor, then the typed refusal names the fold\'s own reason')
{
  const shape = OVERFLOW_WIRE_SHAPES.anthropic!
  const refused = { error: { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 201000 tokens > 200000 maximum' } } } } as const
  fixture.script([{ error: { status: shape.status, body: shape.body } }, ...Array.from({ length: 14 }, () => refused), { text: 'never reached' }])
  const r = await drive('claude-opus-4-8', 3)
  check('terminal prompt_too_long, the run never threw', r.threw === undefined && r.terminal.reason === 'prompt_too_long', `threw=${r.threw ?? 'no'} terminal=${JSON.stringify(r.terminal)}`)
  const errs = errorTexts(r.yields)
  check('exactly one typed refusal yields', errs.length === 1, JSON.stringify(errs))
  check('it leads with the stable content key and names the fold\'s own reason', errs[0] !== undefined && errs[0].startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE) && errs[0].includes(`the fold failed (${ERROR_MESSAGE_PROMPT_TOO_LONG})`), errs[0])
  check('no reply was attempted on a request known not to fit (no "never reached" request)', !r.wire.some(w => wireText(w.body).includes('never reached')) && lastAssistantText(r.yields).startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE))
  check('the raw provider sentence never reaches a yield', !r.yields.some(y => textOf(y).includes('213462 tokens > 200000')))
}

section('F5 a long history keeps its verbatim tail through the overflow fold; the operator message still rides last')
{
  process.env.MERCURY_COMPACT_KEEP_TAIL = '1'
  const shape = OVERFLOW_WIRE_SHAPES.anthropic!
  fixture.script([
    { error: { status: shape.status, body: shape.body } },
    { text: 'SUMMARY: twelve modules adjusted.' },
    { text: 'recovered with a tail', usage: { input: 2000, output: 10 } },
  ])
  const r = await drive('claude-opus-4-8', 12)
  delete process.env.MERCURY_COMPACT_KEEP_TAIL
  check('the run completed in three requests', r.threw === undefined && r.terminal.reason === 'completed' && r.wire.length === 3, `threw=${r.threw ?? 'no'} terminal=${JSON.stringify(r.terminal)} wire=${r.wire.length}`)
  const retry = r.wire[2]
  const body = retry !== undefined ? wireText(retry.body) : ''
  check('the verbatim tail rode the fold (a recent round is on the retried request in full)', body.includes('reply 11: module 11 adjusted'), body.slice(0, 200))
  check('the oldest history did not (it lives in the summary)', !body.includes('reply 0: module 0 adjusted'))
  check('the operator message rides LAST, after the tail', retry !== undefined && wireLastUserText('anthropic', retry.body).endsWith(OPERATOR_ASK))
  const meta = (boundaryOf(r.yields) as { compactMetadata?: { trigger?: string; preservedSegment?: unknown } } | undefined)?.compactMetadata
  check("the boundary is typed 'overflow' and records the preserved segment", meta?.trigger === 'overflow' && meta.preservedSegment !== undefined, JSON.stringify(meta))
  const transcript = [...seed(12), ...r.yields.filter(y => y.type === 'user' || y.type === 'assistant' || y.type === 'system')]
  const fill = contextFill(transcript as never)
  check('the gauge anchors on the retried turn (2000+10), never the re-homed tail\'s pre-fold usage', fill.source === 'usage' && fill.tokens === 2010, JSON.stringify(fill))
}

section('F6 early folding off never disables the real emergency fold, on either overflow road')
{
  const { saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
  for (const off of ['config', 'environment'] as const) {
    if (off === 'config') saveGlobalConfig(c => ({ ...c, autoCompactEnabled: false }))
    else process.env.MERCURY_AUTO_COMPACT = '0'
    for (const source of ['provider', 'estimate'] as const) {
      fixture.script([
        ...(source === 'provider' ? [{ error: OVERFLOW_WIRE_SHAPES.anthropic! }] : []),
        { text: 'SUMMARY: the older work is complete; continue the operator request.' },
        { text: 'recovered with early folding off', usage: { input: 640, output: 12 } },
      ])
      const r = await drive('claude-sonnet-5-5', 5, source === 'estimate' ? 990_000 : undefined)
      const boundary = boundaryOf(r.yields) as { compactMetadata?: { trigger?: string; overflow?: { source?: string } } } | undefined
      check(`${off} off / ${source}: the real emergency fold completed`, r.threw === undefined && r.terminal.reason === 'completed' && boundary?.compactMetadata?.trigger === 'overflow' && boundary.compactMetadata.overflow?.source === source, JSON.stringify({ terminal: r.terminal, boundary }))
      check(`${off} off / ${source}: only the needed calls, no refusal, ask preserved`, r.wire.length === (source === 'provider' ? 3 : 2) && errorTexts(r.yields).length === 0 && wireLastUserText('anthropic', r.wire.at(-1)!.body).endsWith(OPERATOR_ASK))
      fixture.script([{ text: 'the next turn works', usage: { input: 700, output: 8 } }])
      const continued = [...seed(5), ...r.yields.filter(m => ['user', 'assistant', 'system', 'attachment'].includes(m.type ?? '')), createUserMessage({ content: 'Continue on the same conversation.' })] as AnyMsg[]
      const next = await drive('claude-sonnet-5-5', 0, undefined, continued)
      check(`${off} off / ${source}: the next turn is not refused`, next.terminal.reason === 'completed' && errorTexts(next.yields).length === 0)
    }
    if (off === 'config') saveGlobalConfig(c => ({ ...c, autoCompactEnabled: true }))
    else delete process.env.MERCURY_AUTO_COMPACT
  }
}

await fixture.close()
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
