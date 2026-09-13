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
  console.log('\nTIMEOUT — switch-window fold prover exceeded 240s')
  process.exit(1)
}, 240_000)
watchdog.unref?.()

delete process.env.NODE_ENV
for (const ambient of [
  'ANTHROPIC_API_KEY', 'MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE',
  'GOOGLE_API_KEY', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_OVERFLOW_RECOVERY', 'MERCURY_BLOCKING_LIMIT_OVERRIDE',
  'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_COMPACT_KEEP_TAIL',
  'MERCURY_CONCOURSE_WORKER',
]) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'switch-window-fold-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'switch-window-fold-daemon-'))
process.env.MERCURY_TEAMS_DIR = mkdtempSync(join(tmpdir(), 'switch-window-fold-teams-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.BROWSER = '/usr/bin/true'

const { startOverflowFixture, OVERFLOW_WIRE_SHAPES } = await import('./overflowFixture.ts')
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)

console.log('============================================================')
console.log(' the switch and the window — the real fold over the loopback')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { query } = await import('../../src/query.ts')
const { productionDeps } = await import('../../src/query/deps.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { contextFill } = await import('../../src/utils/tokens.ts')
const { primeOpenaiCatalogue } = await import('../../src/services/providers/openai/openaiCatalogue.ts')
const autoCompactModule = await import('../../src/services/compact/autoCompact.ts')
const { getBlockingLimit, resolveAutoCompactWindow } = autoCompactModule
const foldModelFor = (autoCompactModule as Partial<typeof autoCompactModule>).foldModelFor
const previewModule = await import('../../src/services/providers/transitionPreview.ts')
const { buildTransitionPlan, transitionPlanSummary, transitionCapabilityEpoch } = previewModule
const transitionWindowFact = (previewModule as Partial<typeof previewModule>).transitionWindowFact
const cardModule = await import('../../src/components/TransitionPreviewCard.tsx')
const windowRowWords = (cardModule as Partial<typeof cardModule>).windowRowWords
const recoveryModule = await import('../../src/services/compact/overflowRecovery.ts')
const { overflowRecoveryNotice, overflowRefusalText } = recoveryModule
const measureOverflow = (recoveryModule as Partial<typeof recoveryModule>).measureOverflow
const absent = (name: string): never => {
  throw new Error(`${name} is not exported by this tree`)
}
const fold = foldModelFor ?? ((..._args: unknown[]): never => absent('foldModelFor'))
const windowFact = transitionWindowFact ?? ((..._args: unknown[]): never => absent('transitionWindowFact'))
const rowWords = windowRowWords ?? ((..._args: unknown[]): never => absent('windowRowWords'))
const measure = measureOverflow ?? ((..._args: unknown[]): never => absent('measureOverflow'))
const guarded = (label: string, body: () => void): void => {
  try {
    body()
  } catch (error) {
    check(`${label} runs on this tree`, false, error instanceof Error ? error.message : String(error))
  }
}

const SEATED = 'gpt-5.6-sol'
const SOURCE = 'claude-opus-4-8'
const WINDOW = 20_000
const CEILING = 400_000
let primes = 0
function primeWindow(window: number, ceiling?: number): void {
  primes++
  const primed = primeOpenaiCatalogue({
    sourceKind: 'api-key',
    models: [
      {
        id: SEATED,
        displayName: 'GPT-5.6 Sol',
        supportedReasoningEfforts: ['low', 'high'],
        reasoningEffortsStated: true,
        defaultReasoningEffort: 'low',
        visibility: 'list',
        supportedInApi: true,
        priority: 1,
        contextWindow: window,
        ...(ceiling !== undefined ? { maxContextWindow: ceiling } : {}),
        inputModalities: ['text', 'image'],
      },
    ],
    fetchedAtMs: Date.now() + primes,
  })
  if (!primed) throw new Error('the catalogue prime was refused')
}

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

const OPERATOR_ASK = 'operator ask: carry on from the long design note'
const NOTE_CHARS = 120_000
function bigNote(): string {
  const sentence = 'The note walks the module boundaries, the ports, the records and the checks that keep them honest. '
  let out = ''
  while (out.length < NOTE_CHARS) out += sentence
  return out
}
function seed(stampedModel: string): unknown[] {
  const note = bigNote()
  return [
    createUserMessage({ content: 'write the long design note' }),
    {
      type: 'assistant',
      uuid: '00000000-0000-4000-a000-000000000011',
      timestamp: new Date().toISOString(),
      requestId: 'req_note',
      message: {
        id: 'msg_note',
        type: 'message',
        role: 'assistant',
        model: stampedModel,
        content: [{ type: 'text', text: note }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 400, output_tokens: Math.round(note.length / 4), cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    },
    createUserMessage({ content: OPERATOR_ASK }),
  ]
}

type Drive = { yields: AnyMsg[]; terminal: Record<string, unknown>; threw: string | undefined; wire: ReturnType<typeof fixture.captured.slice> }
async function drive(model: string, messages: unknown[]): Promise<Drive> {
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
const noticeTexts = (yields: AnyMsg[]): string[] => yields.filter(y => y.type === 'system' && (y as { subtype?: string }).subtype !== 'compact_boundary').map(y => String(y.content ?? ''))
const dialects = (d: Drive): string => d.wire.map(w => w.dialect).join('→')
const fmt = (n: number): string => n.toLocaleString('en-US')

section('W0 the primed window is the window Mercury resolves for the seated model')
{
  primeWindow(WINDOW)
  check('the flat prime budgets the seated model at the declared window', resolveAutoCompactWindow(SEATED).window === WINDOW, String(resolveAutoCompactWindow(SEATED).window))
  primeWindow(WINDOW, CEILING)
  check('the ceiling prime budgets the seated model at the declared ceiling', resolveAutoCompactWindow(SEATED).window === CEILING, String(resolveAutoCompactWindow(SEATED).window))
  check("the source model's limit holds the note", getBlockingLimit(SOURCE) > contextFill(seed(SOURCE) as never).tokens, `${getBlockingLimit(SOURCE)} vs ${contextFill(seed(SOURCE) as never).tokens}`)
}

section('W1 the declared ceiling above the served default: the request goes out, the notice carries Mercury\'s count and window, the fold runs on the source')
{
  primeWindow(WINDOW, CEILING)
  const shape = OVERFLOW_WIRE_SHAPES.openai!
  fixture.script([
    { error: { status: shape.status, body: shape.body } },
    { text: 'SUMMARY BY OPUS: the long design note was written; the operator asks to carry on.' },
    { text: 'sol carries on from the note', usage: { input: 900, output: 12 } },
  ])
  const messages = seed(SOURCE)
  const expected = contextFill(messages as never, SEATED).tokens
  const r = await drive(SEATED, messages)
  check('the run completed without throwing', r.threw === undefined && r.terminal.reason === 'completed', `threw=${r.threw ?? 'no'} terminal=${JSON.stringify(r.terminal)}`)
  check('three requests: the refused request on the target, the summary on the SOURCE wire, the retry on the target', dialects(r) === 'responses→anthropic→responses', dialects(r))
  const notice = noticeTexts(r.yields).find(t => t.startsWith('context overflowed'))
  check("the notice names Mercury's count and the window it measured against", notice !== undefined && /^context overflowed \(OpenAI; about [\d,]+ tokens by Mercury's count against the 400,000-token window\) — folding the conversation and retrying$/.test(notice), JSON.stringify(noticeTexts(r.yields)))
  const named = notice === undefined ? NaN : Number.parseInt((/about ([\d,]+) tokens/.exec(notice)?.[1] ?? '').replace(/,/g, ''), 10)
  check("the count in the notice is Mercury's own count of the history for the seated model", Number.isFinite(named) && Math.abs(named - expected) <= Math.max(200, expected * 0.05), `notice=${named} expected≈${expected}`)
  const meta = (boundaryOf(r.yields) as { compactMetadata?: { trigger?: string; overflow?: { measuredTokens?: number; measuredWindow?: number; actualTokens?: number } } } | undefined)?.compactMetadata
  check("the boundary is typed 'overflow' and its signal carries the measured count and window", meta?.trigger === 'overflow' && meta.overflow?.measuredTokens === named && meta.overflow.measuredWindow === CEILING, JSON.stringify(meta))
  check('the reply settled last; no error row yields', lastAssistantText(r.yields) === 'sol carries on from the note' && errorTexts(r.yields).length === 0, JSON.stringify(errorTexts(r.yields)))
  check('the retried request rode the summary under the window', r.wire[2] !== undefined && JSON.stringify(r.wire[2].body).includes('SUMMARY BY OPUS'))
}

section('W2 the flat window: the loop head folds before the first request, on the source wire')
{
  primeWindow(WINDOW)
  fixture.script([
    { text: 'SUMMARY BY OPUS: the long design note was written; the operator asks to carry on.' },
    { text: 'sol carries on after the fold', usage: { input: 700, output: 10 } },
  ])
  const r = await drive(SEATED, seed(SOURCE))
  check('the run completed', r.threw === undefined && r.terminal.reason === 'completed', `threw=${r.threw ?? 'no'} terminal=${JSON.stringify(r.terminal)}`)
  check('two requests: the summary on the SOURCE wire, then the first request on the target', dialects(r) === 'anthropic→responses', dialects(r))
  check("the boundary is the loop head's own fold (trigger 'auto')", (boundaryOf(r.yields) as { compactMetadata?: { trigger?: string } } | undefined)?.compactMetadata?.trigger === 'auto')
  check('the reply settled last', lastAssistantText(r.yields) === 'sol carries on after the fold', lastAssistantText(r.yields))
}

section('W3 no switch: a history the seated model wrote folds on the seated model')
{
  primeWindow(WINDOW)
  fixture.script([
    { text: 'SUMMARY BY SOL: the long design note was written.' },
    { text: 'sol carries on on its own', usage: { input: 700, output: 10 } },
  ])
  const r = await drive(SEATED, seed(SEATED))
  check('the run completed', r.threw === undefined && r.terminal.reason === 'completed', `threw=${r.threw ?? 'no'} terminal=${JSON.stringify(r.terminal)}`)
  check('both requests rode the seated wire (the summary never leaves the seat without a switch)', dialects(r) === 'responses→responses', dialects(r))
  guarded('W3 the fold-model owner', () => {
    const choice = fold(seed(SEATED) as never, SEATED, { forced: true })
    check('the fold-model owner keeps the seat when the history was written on it', choice.source === 'seated' && choice.model === SEATED, JSON.stringify(choice))
  })
}

section('W4 the fold-model owner: the source wins only when the seat does not hold the history and the source does')
{
  guarded('W4 the fold-model owner', () => {
    primeWindow(WINDOW)
    const messages = seed(SOURCE) as never
    const over = fold(messages, SEATED, { forced: false })
    check("over the seat's limit: the history's model writes the summary", over.source === 'history' && over.model === SOURCE, JSON.stringify(over))
    primeWindow(WINDOW, CEILING)
    const fits = fold(messages, SEATED, { forced: false })
    check('within the budget and not forced: the seat writes the summary', fits.source === 'seated', JSON.stringify(fits))
    const forced = fold(messages, SEATED, { forced: true })
    check('forced by a refusal the budget did not foresee: the history\'s model writes the summary', forced.source === 'history' && forced.model === SOURCE, JSON.stringify(forced))
    const tiny = fold([createUserMessage({ content: 'hello' })] as never, SEATED, { forced: true })
    check('no usage anchor at all: the seat', tiny.source === 'seated', JSON.stringify(tiny))
  })
}

section('W5 the notice and the refusal without a measured count keep their shape')
{
  const bare = { source: 'provider' as const, family: 'openai' as const, shape: 'context-length-exceeded' as const }
  check('an unmeasured signal names the family alone', overflowRecoveryNotice(bare, 'fold') === 'context overflowed (OpenAI) — folding the conversation and retrying')
  guarded('W5 the measured signal', () => {
    const measured = measure(bare, seed(SOURCE) as never, SEATED)
    check('measuring stamps the count and the resolved window', measured.measuredTokens === contextFill(seed(SOURCE) as never, SEATED).tokens && measured.measuredWindow === resolveAutoCompactWindow(SEATED).window, JSON.stringify(measured))
    check('a signal the provider numbered keeps the provider\'s numbers', overflowRecoveryNotice({ ...measured, actualTokens: 135_000, limitTokens: 128_000 }, 'fold') === 'context overflowed (OpenAI: 135,000 tokens > 128,000) — folding the conversation and retrying')
    const refusal = overflowRefusalText(measured, 'retry-overflowed', { nonInteractive: true })
    check('the refusal carries the measured clause', refusal.includes(`about ${fmt(measured.measuredTokens!)} tokens by Mercury's count against the ${fmt(measured.measuredWindow!)}-token window`), refusal)
  })
}

section('W6 the switch preview counts the history against the target window')
{
  primeWindow(WINDOW)
  const messages = seed(SOURCE) as never
  const plan = buildTransitionPlan({ messages, from: SOURCE, to: SEATED })
  const fact = plan.window
  check('the plan carries the window fact', fact !== undefined, JSON.stringify(plan.window))
  check("the count is Mercury's own — at least the last wire count and the estimate", fact !== undefined && fact.count >= contextFill(messages).tokens && fact.count >= contextFill(messages, SEATED).tokens, JSON.stringify(fact))
  check('the window is the catalogue\'s figure and the source says so', fact?.window === WINDOW && fact.windowSource === 'live-current' && fact.limit === getBlockingLimit(SEATED), JSON.stringify(fact))
  check('the history does not fit, so the switch needs a choice', fact?.fits === false && plan.needsChoice === true, JSON.stringify({ fits: fact?.fits, needsChoice: plan.needsChoice, counts: plan.counts }))
  guarded('W6 the card row', () => {
    const words = rowWords(plan, 'Opus 4.8', 'GPT-5.6 Sol')
    check('the card row names the count, the window, its source and the fold before the first request', words !== null && words.includes("by Mercury's count") && words.includes(`${fmt(WINDOW)} tokens`) && words.includes("the OpenAI catalogue's figure for this account") && words.includes('confirm folds the conversation on Opus 4.8 before the first request on GPT-5.6 Sol'), words ?? 'null')
  })
  const summary = transitionPlanSummary(plan)
  check('the receipt suffix carries the numbers and the fold', summary.includes(`by Mercury's count against the ${fmt(WINDOW)}-token window — the conversation folds before the first request`), summary)
  const small = buildTransitionPlan({ messages: [createUserMessage({ content: 'hello' }), createUserMessage({ content: OPERATOR_ASK })] as never, from: SOURCE, to: SEATED })
  check('a small history fits and needs no choice', small.window?.fits === true && small.needsChoice === false, JSON.stringify(small.window))
  guarded('W6 a fitting plan', () => {
    check('a fitting plan carries no window row and no window clause', rowWords(small, 'Opus 4.8', 'GPT-5.6 Sol') === null && !transitionPlanSummary(small).includes('window'))
  })
  guarded('W6 the epoch', () => {
    const flatEpoch = transitionCapabilityEpoch(SEATED, true, windowFact(messages, SEATED))
    primeWindow(WINDOW, CEILING)
    const ceilingEpoch = transitionCapabilityEpoch(SEATED, true, windowFact(messages, SEATED))
    check('a window that lands between preview and confirm changes the capability epoch (the plan regenerates)', flatEpoch !== ceilingEpoch)
  })
  primeWindow(WINDOW, CEILING)
  const roomy = buildTransitionPlan({ messages, from: SOURCE, to: SEATED })
  check('under the declared ceiling the same history fits by Mercury\'s budget', roomy.window?.fits === true && roomy.window.window === CEILING, JSON.stringify(roomy.window))
}

await fixture.close()
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
