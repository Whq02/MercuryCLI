#!/usr/bin/env bun
// ============================================================================
//  scripts/compact/prove-overflow-real-fold.ts — the overflow ladder END TO
//  END on the REAL road: the production model router, the production
//  compaction owner (the mechanical fold), the real turn machine, and a
//  loopback that speaks each family's wire — "the first request overflows,
//  the fold's summary call answers, the retry answers" staged exactly.
//
//    F1  the home lane (Anthropic): overflow → the real fold → the retry →
//        a reply; the boundary row is the REAL compact_boundary typed
//        'overflow' with the signal on its metadata; the retried request
//        opens on the summary and ends with the operator message verbatim;
//        the token gauge after the recovery anchors on the retried turn's
//        own usage (the compact-frontier fence) — never the pre-fold weight
//    F2  a chat-completions family (OpenRouter through the compat runtime):
//        the same laws, the family's own numbers on the boundary
//    F3  the fold itself overflows: the summary call is refused too; the
//        fold's retry-by-truncation drops the head and lands; the run
//        completes (four requests, the second summary smaller than the
//        first)
//    F4  the fold cannot shrink under the window: every summary attempt is
//        refused; the forced fold fails typed and the run refuses with the
//        fold's own reason — never a raw sentence, never a silent stop
//    F5  a long history keeps its verbatim tail through the overflow fold
//        and the operator message still rides last
//
//  Run: ~/.bun/bin/bun run scripts/compact/prove-overflow-real-fold.ts
// ============================================================================
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

// ── env hygiene BEFORE any src import ───────────────────────────────────────
delete process.env.NODE_ENV
for (const ambient of [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_SIMPLE',
  'GOOGLE_API_KEY', 'DISABLE_COMPACT', 'DISABLE_AUTO_COMPACT', 'MERCURY_OVERFLOW_RECOVERY', 'MERCURY_BLOCKING_LIMIT_OVERRIDE',
  'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_COMPACT_KEEP_TAIL',
]) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'overflow-real-fold-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'overflow-real-fold-daemon-'))
process.env.MERCURY_TEAMS_DIR = mkdtempSync(join(tmpdir(), 'overflow-real-fold-teams-'))
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
      mainLoopModel: model,
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
async function drive(model: string, rounds: number): Promise<Drive> {
  const before = fixture.captured.length
  const deps = productionDeps()
  const yields: AnyMsg[] = []
  let terminal: Record<string, unknown> = {}
  let threw: string | undefined
  try {
    const gen = query({
      messages: seed(rounds) as never,
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
/** The last message's text on the wire, per dialect. */
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

// ── F1 ──────────────────────────────────────────────────────────────────────
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
  // The home wire merges consecutive user rows into one message (the
  // summary, the post-compact notes, the operator's turn) — the operator's
  // words are the LAST block the model reads.
  check('the retried request ends with the operator message VERBATIM', retry !== undefined && wireLastUserText('anthropic', retry.body).endsWith(OPERATOR_ASK), retry !== undefined ? wireLastUserText('anthropic', retry.body).slice(-80) : 'no retry')
  check('the retried request opens on the summary, not the folded history', retry !== undefined && wireText(retry.body).includes('SUMMARY: the earlier modules') && !wireText(retry.body).includes('ask 0: adjust module 0'))
  const boundary = boundaryOf(r.yields)
  const meta = (boundary as { compactMetadata?: { trigger?: string; overflow?: { family?: string; shape?: string; actualTokens?: number }; preTokens?: number } } | undefined)?.compactMetadata
  check("the REAL compact_boundary row yields, typed 'overflow'", meta?.trigger === 'overflow', JSON.stringify(meta))
  check('…carrying the signal (anthropic · prompt-too-long · 213462) and the folded weight', meta?.overflow?.family === 'anthropic' && meta.overflow.shape === 'prompt-too-long' && meta.overflow.actualTokens === 213_462 && typeof meta.preTokens === 'number' && meta.preTokens > 0, JSON.stringify(meta))
  check('the summary row yields (isCompactSummary)', r.yields.some(y => y.type === 'user' && (y as { isCompactSummary?: boolean }).isCompactSummary === true))
  check('the last settled assistant is the reply', lastAssistantText(r.yields) === 'the recovered answer', lastAssistantText(r.yields))
  check('no API-error row ever yields (the refusal was withheld and recovered)', errorTexts(r.yields).length === 0, JSON.stringify(errorTexts(r.yields)))
  check('the notice speaks', r.yields.some(y => y.type === 'system' && String(y.content ?? '').includes('context overflowed (Anthropic: 213,462 tokens > 200,000) — folding the conversation and retrying')))
  // The gauge law: over the transcript as the REPL now holds it (the seed
  // plus everything that yielded), the fill anchors on the retried turn's
  // own usage — the fence retires every pre-fold anchor.
  const transcript = [...seed(5), ...r.yields.filter(y => y.type === 'user' || y.type === 'assistant' || y.type === 'system')]
  const fill = contextFill(transcript as never)
  check('the gauge after the recovery anchors on the retried turn\'s usage (source usage, the fixture\'s 640+12)', fill.source === 'usage' && fill.tokens === 652, JSON.stringify(fill))
}

// ── F2 ──────────────────────────────────────────────────────────────────────
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

// ── F3 ──────────────────────────────────────────────────────────────────────
section('F3 the fold itself overflows — the retry-by-truncation lands the summary')
{
  const shape = OVERFLOW_WIRE_SHAPES.anthropic!
  fixture.script([
    { error: { status: shape.status, body: shape.body } },
    { error: { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 201000 tokens > 200000 maximum' } } } },
    { text: 'SUMMARY after truncation: the later modules were adjusted; the operator asks to land the change.' },
    { text: 'recovered after a truncated fold', usage: { input: 300, output: 8 } },
  ])
  const r = await drive('claude-opus-4-8', 6)
  check('the run completed', r.threw === undefined && r.terminal.reason === 'completed', `threw=${r.threw ?? 'no'} terminal=${JSON.stringify(r.terminal)}`)
  check('four requests: overflow · summary (refused) · summary (truncated) · retry', r.wire.length === 4, String(r.wire.length))
  const first = r.wire[1]
  const second = r.wire[2]
  check('the first summary call carried the whole head', first !== undefined && wireText(first.body).includes('ask 0: adjust module 0'))
  check('the second summary call dropped the head (the oldest round is gone, the rest stands)', second !== undefined && !wireText(second.body).includes('ask 0: adjust module 0') && wireText(second.body).includes('reply 5: module 5 adjusted'), second !== undefined ? `${wireMessageCount('anthropic', second.body)} messages` : 'no second call')
  check('the reply settled last', lastAssistantText(r.yields) === 'recovered after a truncated fold', lastAssistantText(r.yields))
  check("the boundary is typed 'overflow'", (boundaryOf(r.yields) as { compactMetadata?: { trigger?: string } } | undefined)?.compactMetadata?.trigger === 'overflow')
}

// ── F4 ──────────────────────────────────────────────────────────────────────
section('F4 the fold cannot shrink under the window — the typed refusal names the fold\'s own reason')
{
  const shape = OVERFLOW_WIRE_SHAPES.anthropic!
  const refused = { error: { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 201000 tokens > 200000 maximum' } } } } as const
  fixture.script([{ error: { status: shape.status, body: shape.body } }, refused, refused, refused, refused, refused, refused, { text: 'never reached' }])
  const r = await drive('claude-opus-4-8', 3)
  check('terminal prompt_too_long, the run never threw', r.threw === undefined && r.terminal.reason === 'prompt_too_long', `threw=${r.threw ?? 'no'} terminal=${JSON.stringify(r.terminal)}`)
  const errs = errorTexts(r.yields)
  check('exactly one typed refusal yields', errs.length === 1, JSON.stringify(errs))
  check('it leads with the stable content key and names the fold\'s own reason', errs[0] !== undefined && errs[0].startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE) && errs[0].includes(`the fold failed (${ERROR_MESSAGE_PROMPT_TOO_LONG})`), errs[0])
  check('no reply was attempted on a request known not to fit (no "never reached" request)', !r.wire.some(w => wireText(w.body).includes('never reached')) && lastAssistantText(r.yields).startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE))
  check('the raw provider sentence never reaches a yield', !r.yields.some(y => textOf(y).includes('213462 tokens > 200000')))
}

// ── F5 ──────────────────────────────────────────────────────────────────────
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
  check('the oldest history did not (it lives in the summary)', !body.includes('ask 0: adjust module 0'))
  check('the operator message rides LAST, after the tail', retry !== undefined && wireLastUserText('anthropic', retry.body).endsWith(OPERATOR_ASK))
  const meta = (boundaryOf(r.yields) as { compactMetadata?: { trigger?: string; preservedSegment?: unknown } } | undefined)?.compactMetadata
  check("the boundary is typed 'overflow' and records the preserved segment", meta?.trigger === 'overflow' && meta.preservedSegment !== undefined, JSON.stringify(meta))
  const transcript = [...seed(12), ...r.yields.filter(y => y.type === 'user' || y.type === 'assistant' || y.type === 'system')]
  const fill = contextFill(transcript as never)
  check('the gauge anchors on the retried turn (2000+10), never the re-homed tail\'s pre-fold usage', fill.source === 'usage' && fill.tokens === 2010, JSON.stringify(fill))
}

await fixture.close()
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
