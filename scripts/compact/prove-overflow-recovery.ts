#!/usr/bin/env bun
// ============================================================================
//  scripts/compact/prove-overflow-recovery.ts — the context-overflow
//  RECOVERY LADDER on the real turn machine (the deps seam: a scripted model
//  and a scripted compaction owner, the real loop around them). Where the
//  product used to END THE TURN, it now answers the overflow in-turn.
//
//    R1  first-call overflow → the fold rung → the retry → a REPLY: the
//        operator's message rides the retried request VERBATIM around the
//        fold; the boundary is typed 'overflow'; the raw refusal never
//        yields (withheld); the notice speaks; terminal completed
//    R2  the retry overflows again → the typed refusal (what was tried,
//        the numbers, the remedy) — never the raw sentence; exactly two
//        calls; terminal prompt_too_long; the SDK-shaped last message
//    R3  the prune rung — superseded tool results outside the keep-recent
//        window cover the named gap: pruned, retried, replied — NO fold;
//        the placeholders ride the retried request; the newest window is
//        untouched; the replacement ledger holds the prune
//    R4  the prune cannot cover a large gap → straight to the fold
//    R5  the switches — DISABLE_AUTO_COMPACT names /compact (interactive)
//        or the headless remedy; DISABLE_COMPACT names itself; the flag OFF
//        restores today's surface byte-for-byte in shape (the raw error is
//        the settled reply, terminal completed, one call)
//    R6  the failure breaker — a tripped compaction breaker refuses typed
//    R7  mid-tool overflow — the follow-up call after a tool round: the
//        fold input is the paired round (a legal boundary), the retry
//        carries no unpaired tool_use, the run completes
//    R8  the estimate side — the blocking preempt prunes when the local
//        gap is covered (the call then proceeds); otherwise refuses typed
//        with today's terminal and the stable content key leading
//    R9  service forks never enter — a compact-source overflow surfaces
//        as today
//    R10 the interactive refusal names the slash-command remedies
//    R11 the episode law — a completed tool round opens a fresh episode
//        (a second fold later in the run is allowed); the rapid-refill
//        breaker still ends a fold-refill thrash
//    R12 the forced fold fails at the head → refusal names the reason,
//        the model is never called on a request known not to fit
//    R13 a lone message larger than the window → 'single-message'
//
//  Run: ~/.bun/bin/bun run scripts/compact/prove-overflow-recovery.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

// ── hermetic env (BEFORE any src import) ────────────────────────────────────
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'overflow-recovery-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'overflow-recovery-daemon-'))
process.env.MERCURY_TEAMS_DIR = mkdtempSync(join(tmpdir(), 'overflow-recovery-teams-'))
for (const k of [
  'MERCURY_SIMPLE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_BLOCKING_LIMIT_OVERRIDE',
  'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_RELEVANT_RECALL', 'CLAUDE_TEAM_NAME', 'CLAUDE_AGENT_NAME',
  'DISABLE_COMPACT', 'DISABLE_AUTO_COMPACT', 'MERCURY_OVERFLOW_RECOVERY', 'MERCURY_TIME_BASED_MC', 'NODE_ENV',
  'ANTHROPIC_MODEL',
]) {
  delete process.env[k]
}
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const { queryEvents } = await import('../../src/query.ts')
const { legacyYieldsOf } = await import('../../src/run-core/project-legacy.ts')
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createAssistantMessage, createAssistantAPIErrorMessage, createUserMessage } = await import('../../src/utils/messages.ts')
const { createCompactBoundaryMessage } = await import('../../src/utils/messages/systemMessages.ts')
const { PROMPT_TOO_LONG_ERROR_MESSAGE } = await import('../../src/services/api/errors.ts')
const { AUTOCOMPACT_THRASH_MESSAGE } = await import('../../src/services/compact/autoCompact.ts')
const { MC_DIGEST_PREFIX, MC_CLEARED_PLACEHOLDER } = await import('../../src/services/compact/microCompactDigest.ts')
const { createContentReplacementState } = await import('../../src/utils/toolResultStorage.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { tokenCountWithEstimation } = await import('../../src/utils/tokens.ts')
const { overflowSignalOf } = await import('../../src/services/api/overflowSignal.ts')

type Sig = import('../../src/services/api/overflowSignal.ts').OverflowSignal
type AnyMsg = Record<string, unknown> & { type?: string }
type AnyEvent = Record<string, unknown> & { kind: string }

const MODEL = 'claude-opus-4-8'
let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — overflow recovery prover exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

console.log('============================================================')
console.log(' context-overflow recovery ladder — the real loop, scripted deps')
console.log('============================================================')

// ── rig ─────────────────────────────────────────────────────────────────────
const textOf = (m: unknown): string => {
  const msg = m as AnyMsg
  const c = (msg.message as { content?: unknown } | undefined)?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return (c as AnyMsg[]).filter(b => b.type === 'text').map(b => String(b.text ?? '')).join('\n')
  if (typeof msg.content === 'string') return msg.content
  return ''
}
const OPENAI_RAW = "This model's maximum context length is 128000 tokens. However, your messages resulted in 135000 tokens. Please reduce the length of the messages."
const OPENAI_SIGNAL: Sig = { source: 'provider', family: 'openai', shape: 'context-length-exceeded', actualTokens: 135_000, limitTokens: 128_000, detail: OPENAI_RAW }
const overflowError = (signal: Sig = OPENAI_SIGNAL): unknown =>
  createAssistantAPIErrorMessage({
    content: `API Error: OpenAI stream failed (openai-context_length_exceeded) — ${OPENAI_RAW}`,
    error: 'invalid_request',
    errorDetails: 'openai-context_length_exceeded',
    overflow: signal,
  })
const asstText = (text: string): unknown => createAssistantMessage({ content: text })
const asstToolUse = (id: string, name: string, input: Record<string, unknown>): unknown =>
  createAssistantMessage({ content: [{ type: 'tool_use', id, name, input }] as never })
const ping = (): unknown => ({ type: 'stream_event', event: { type: 'ping' } })

type CallRecord = { model: unknown; messages: unknown[] }
function makeModel(script: unknown[][]): { calls: CallRecord[]; callModel: (req: never) => AsyncGenerator<never, void> } {
  const calls: CallRecord[] = []
  async function* callModel(req: { messages: unknown[]; options: Record<string, unknown> }): AsyncGenerator<never, void> {
    const idx = calls.length
    calls.push({ model: req.options.model, messages: [...req.messages] })
    const steps = script[idx]
    if (!steps) throw new Error(`model script exhausted at call ${idx}`)
    for (const s of steps) yield s as never
  }
  return { calls, callModel: callModel as never }
}

type CompactCall = { messages: unknown[]; forced: Sig | undefined }
type CompactAnswer = Record<string, unknown> | ((call: CompactCall) => Record<string, unknown>)
/** The scripted compaction owner: records every call with its forced
 *  signal; answers forced calls from `onForced` (in order, the last one
 *  repeating) and threshold calls from `onThreshold` (same rule). */
function makeCompact(opts: { onForced?: CompactAnswer[]; onThreshold?: CompactAnswer[] } = {}) {
  const calls: CompactCall[] = []
  let forcedIdx = 0
  let thresholdIdx = 0
  const answer = (list: CompactAnswer[] | undefined, idx: number, call: CompactCall, fallback: Record<string, unknown>): Record<string, unknown> => {
    if (!list || list.length === 0) return fallback
    const a = list[Math.min(idx, list.length - 1)]!
    return typeof a === 'function' ? a(call) : a
  }
  const autocompact = async (messages: unknown[], _ctx: unknown, _cache: unknown, _source?: string, _tracking?: unknown, _snip?: number, forced?: Sig) => {
    const call: CompactCall = { messages: [...messages], forced }
    calls.push(call)
    if (forced !== undefined) return answer(opts.onForced, forcedIdx++, call, rigFoldResult())
    return answer(opts.onThreshold, thresholdIdx++, call, { wasCompacted: false })
  }
  return { calls, autocompact }
}
function rigFoldResult(): Record<string, unknown> {
  const boundaryMarker = createCompactBoundaryMessage('overflow', 900)
  const summary = createUserMessage({ content: 'RIG SUMMARY of the folded history', isCompactSummary: true })
  return {
    wasCompacted: true,
    compactionResult: {
      boundaryMarker,
      summaryMessages: [summary],
      attachments: [],
      hookResults: [],
      preCompactTokenCount: 900,
      postCompactTokenCount: 120,
      truePostCompactTokenCount: 120,
      compactionUsage: undefined,
    },
  }
}
const passthroughMicrocompact = undefined

function makeTool(name: string): never {
  return {
    name,
    async description() {
      return 'rig tool'
    },
    async prompt() {
      return 'rig tool'
    },
    inputSchema: z.object({ text: z.string().optional() }),
    userFacingName: () => name,
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isMcp: false,
    needsPermissions: () => false,
    async validateInput() {
      return { result: true }
    },
    call: async (input: Record<string, unknown>) => ({ data: `echo:${String(input?.text ?? '')}` }),
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({ type: 'tool_result', tool_use_id: toolUseId, content: String(data) }),
  } as never
}
const allowAll = async (_tool: unknown, input: Record<string, unknown>) => ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }) as never

function makeCtx(opts: { interactive?: boolean; ledger?: boolean } = {}): Record<string, unknown> {
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      tools: [makeTool('EchoTool')],
      mainLoopModel: MODEL,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: opts.interactive !== true,
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
    ...(opts.ledger === true ? { contentReplacementState: createContentReplacementState() } : {}),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId: undefined,
  }
}

type RunResult = {
  events: AnyEvent[]
  yields: AnyMsg[]
  terminal: Record<string, unknown>
  calls: CallRecord[]
  compact: CompactCall[]
  ctx: Record<string, unknown>
}
async function run(opts: {
  seed: unknown[]
  script: unknown[][]
  compact?: ReturnType<typeof makeCompact>
  querySource?: string
  interactive?: boolean
  ledger?: boolean
}): Promise<RunResult> {
  const ctx = makeCtx({ interactive: opts.interactive, ledger: opts.ledger })
  const { calls, callModel } = makeModel(opts.script)
  const compact = opts.compact ?? makeCompact()
  const gen = queryEvents({
    messages: opts.seed as never,
    systemPrompt: ['rig system prompt'] as never,
    userContext: {},
    systemContext: {},
    canUseTool: allowAll as never,
    toolUseContext: ctx as never,
    querySource: (opts.querySource ?? 'sdk') as never,
    deps: {
      callModel: callModel as never,
      autocompact: compact.autocompact as never,
      ...(passthroughMicrocompact !== undefined ? { microcompact: passthroughMicrocompact } : {}),
      uuid: (() => {
        let n = 0
        return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
      })(),
    } as never,
  })
  const events: AnyEvent[] = []
  const yields: AnyMsg[] = []
  let r = await gen.next()
  while (!r.done) {
    const ev = r.value as unknown as AnyEvent
    events.push(ev)
    for (const y of legacyYieldsOf(ev as never)) yields.push(y as AnyMsg)
    r = await gen.next()
  }
  await new Promise(resolve => setTimeout(resolve, 5))
  return { events, yields, terminal: r.value as Record<string, unknown>, calls, compact: compact.calls, ctx }
}

// ── seeds ───────────────────────────────────────────────────────────────────
const OPERATOR_ASK = 'operator ask: land the change and run its checks'
function seedPlain(): unknown[] {
  const earlier = createAssistantMessage({ content: 'earlier reply' })
  return [createUserMessage({ content: 'earlier ask' }), earlier, createUserMessage({ content: OPERATOR_ASK })]
}
/** N Read rounds with ~2,000-char results (~500 tokens each), then the
 *  operator's ask — the shape the prune rung exists for. */
function seedWithReads(rounds: number, lastUsage?: number): unknown[] {
  const out: unknown[] = [createUserMessage({ content: 'earlier ask' })]
  for (let i = 0; i < rounds; i++) {
    const asst = createAssistantMessage({
      content: [{ type: 'tool_use', id: `toolu_read_${i}`, name: 'Read', input: { file_path: `/tmp/rig/file-${i}.txt` } }] as never,
      ...(lastUsage !== undefined && i === rounds - 1
        ? { usage: { input_tokens: lastUsage, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } as never }
        : {}),
    })
    out.push(asst)
    out.push({
      type: 'user',
      uuid: `00000000-0000-4000-b000-0000000000${String(10 + i)}`,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_read_${i}`, content: `file ${i} body ${'lorem ipsum dolor sit amet '.repeat(74)}` }] },
    })
  }
  out.push(createUserMessage({ content: OPERATOR_ASK }))
  return out
}
const toolResultsOf = (msgs: unknown[]): Array<{ id: string; content: unknown }> => {
  const out: Array<{ id: string; content: unknown }> = []
  for (const m of msgs as AnyMsg[]) {
    if (m.type !== 'user') continue
    const c = (m.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(c)) continue
    for (const b of c as AnyMsg[]) if (b.type === 'tool_result') out.push({ id: String(b.tool_use_id), content: b.content })
  }
  return out
}
const isPlaceholder = (content: unknown): boolean =>
  typeof content === 'string' && (content === MC_CLEARED_PLACEHOLDER || content.startsWith(MC_DIGEST_PREFIX))
const lastText = (msgs: unknown[]): string => textOf(msgs[msgs.length - 1])
const settledTransitions = (events: AnyEvent[]): unknown[] => events.filter(e => e.kind === 'turn_settled').map(e => e.transition)
const noticeTexts = (yields: AnyMsg[]): string[] => yields.filter(y => y.type === 'system').map(y => String(y.content ?? ''))
const errorYields = (yields: AnyMsg[]): AnyMsg[] => yields.filter(y => y.type === 'assistant' && y.isApiErrorMessage === true)
const anyYieldCarries = (yields: AnyMsg[], needle: string): boolean => yields.some(y => textOf(y).includes(needle))

// ── R1 ──────────────────────────────────────────────────────────────────────
section('R1 first-call overflow → fold → retry → a REPLY (the operator message verbatim)')
{
  const r = await run({ seed: seedPlain(), script: [[ping(), overflowError()], [ping(), asstText('recovered reply')]] })
  check('terminal completed', r.terminal.reason === 'completed', JSON.stringify(r.terminal))
  check('exactly two model calls (the overflow, the retry)', r.calls.length === 2, String(r.calls.length))
  const forced = r.compact.filter(c => c.forced !== undefined)
  check('the compaction owner was forced exactly once, with the provider signal', forced.length === 1 && forced[0]!.forced?.source === 'provider' && forced[0]!.forced.family === 'openai', JSON.stringify(forced.map(f => f.forced)))
  check('the fold input is the HISTORY only — the operator tail is carried around it', forced.length === 1 && forced[0]!.messages.length === 2 && (forced[0]!.messages[1] as AnyMsg).type === 'assistant', JSON.stringify(forced[0]?.messages.map(m => (m as AnyMsg).type)))
  const retry = r.calls[1]!.messages
  check('the retried request opens on the fold (boundary + summary)', (retry[0] as AnyMsg).type === 'system' && (retry[1] as AnyMsg).isCompactSummary === true, JSON.stringify(retry.map(m => (m as AnyMsg).type)))
  check('…and ends with the operator message VERBATIM', lastText(retry) === OPERATOR_ASK, lastText(retry))
  check('the retried request never carries the refusal', !retry.some(m => (m as AnyMsg).isApiErrorMessage === true))
  const boundary = r.events.find(e => e.kind === 'compaction_boundary')
  check("the boundary event is typed 'overflow'", boundary?.trigger === 'overflow', JSON.stringify(boundary?.trigger))
  const yieldedBoundary = r.yields.find(y => y.type === 'system' && (y as { subtype?: string }).subtype === 'compact_boundary')
  check("the yielded boundary row carries trigger 'overflow' (the glass reads it)", (yieldedBoundary as { compactMetadata?: { trigger?: string } } | undefined)?.compactMetadata?.trigger === 'overflow')
  check('the transition names the rung and the source', JSON.stringify(settledTransitions(r.events)).includes('"reason":"overflow_recovery","rung":"fold","source":"provider"'), JSON.stringify(settledTransitions(r.events)))
  const withheld = r.events.filter(e => e.kind === 'assistant_settled' && e.withheld === true)
  check('the refusal settled WITHHELD (never projected)', withheld.length === 1 && overflowSignalOf((withheld[0]!.message as never)) !== null)
  check('no withheld_surfaced (the ladder recovered)', !r.events.some(e => e.kind === 'withheld_surfaced'))
  check('the raw provider sentence never reaches a yield', !anyYieldCarries(r.yields, 'maximum context length is 128000'))
  check('the notice speaks the compact estate\'s sentence', noticeTexts(r.yields).some(t => t === 'context overflowed (OpenAI: 135,000 tokens > 128,000) — folding the conversation and retrying'), JSON.stringify(noticeTexts(r.yields)))
  const lastAssistant = r.yields.filter(y => y.type === 'assistant').at(-1)
  check('the last settled assistant is the reply', lastAssistant !== undefined && lastAssistant.isApiErrorMessage !== true && textOf(lastAssistant) === 'recovered reply')
}

// ── R2 ──────────────────────────────────────────────────────────────────────
section('R2 the retry overflows again → the typed refusal, never the raw sentence')
{
  const r = await run({ seed: seedPlain(), script: [[ping(), overflowError()], [ping(), overflowError()]] })
  check('terminal prompt_too_long', r.terminal.reason === 'prompt_too_long', JSON.stringify(r.terminal))
  check('exactly two model calls — no third', r.calls.length === 2, String(r.calls.length))
  check('one forced fold, no second', r.compact.filter(c => c.forced !== undefined).length === 1)
  const errs = errorYields(r.yields)
  check('exactly ONE API-error message yields (the typed refusal)', errs.length === 1, String(errs.length))
  const text = errs[0] !== undefined ? textOf(errs[0]) : ''
  check('it leads with the stable content key', text.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE), text)
  check('it names the family and the numbers', text.includes('OpenAI: 135,000 tokens > 128,000'), text)
  check('it says what was tried', text.includes('the conversation was folded and the request retried once, and it still overflows'), text)
  check('it names the headless remedy (this rig is non-interactive)', text.includes('Start a fresh run, or pass --model with a larger window.'), text)
  check('it carries the typed signal for SDK consumers', overflowSignalOf(errs[0] as never)?.family === 'openai')
  check('the raw sentence rides errorDetails, not the row', (errs[0] as { errorDetails?: string }).errorDetails === OPENAI_RAW && !text.includes('However, your messages resulted'))
  check('the raw provider sentence never reaches a yield', !anyYieldCarries(r.yields, 'maximum context length is 128000'))
  check('the last yield is the refusal (the SDK result reads is_error)', r.yields.filter(y => y.type === 'assistant').at(-1)?.isApiErrorMessage === true)
}

// ── R3 ──────────────────────────────────────────────────────────────────────
section('R3 the prune rung — superseded tool results cover the gap; no fold')
{
  const gapSignal: Sig = { ...OPENAI_SIGNAL, actualTokens: 129_000, limitTokens: 128_000 }
  const r = await run({ seed: seedWithReads(8), script: [[ping(), overflowError(gapSignal)], [ping(), asstText('pruned reply')]], ledger: true })
  check('terminal completed', r.terminal.reason === 'completed', JSON.stringify(r.terminal))
  check('two model calls', r.calls.length === 2, String(r.calls.length))
  check('the compaction owner was NEVER forced (no fold)', r.compact.every(c => c.forced === undefined), JSON.stringify(r.compact.map(c => c.forced)))
  check('no boundary event', !r.events.some(e => e.kind === 'compaction_boundary'))
  const retry = r.calls[1]!.messages
  const results = toolResultsOf(retry)
  const cleared = results.filter(x => isPlaceholder(x.content)).map(x => x.id)
  const kept = results.filter(x => !isPlaceholder(x.content)).map(x => x.id)
  check('the three oldest results wear the placeholder', JSON.stringify(cleared) === JSON.stringify(['toolu_read_0', 'toolu_read_1', 'toolu_read_2']), JSON.stringify(cleared))
  check('the newest five are untouched (the keep-recent window)', JSON.stringify(kept) === JSON.stringify(['toolu_read_3', 'toolu_read_4', 'toolu_read_5', 'toolu_read_6', 'toolu_read_7']), JSON.stringify(kept))
  check('the operator message rides the retried request verbatim', lastText(retry) === OPERATOR_ASK)
  check('the transition names the prune rung', JSON.stringify(settledTransitions(r.events)).includes('"reason":"overflow_recovery","rung":"prune","source":"provider"'))
  check('the notice names the count and the reclaimed tokens', noticeTexts(r.yields).some(t => /^context overflowed \(OpenAI: 129,000 tokens > 128,000\) — pruned 3 superseded tool results \(~[\d,]+ tokens\) and retrying$/.test(t)), JSON.stringify(noticeTexts(r.yields)))
  const ledger = (r.ctx.contentReplacementState as { replacements: Map<string, string> }).replacements
  check('the replacement ledger holds the prune (it re-applies on every later request and on resume)', ['toolu_read_0', 'toolu_read_1', 'toolu_read_2'].every(id => isPlaceholder(ledger.get(id))), JSON.stringify([...ledger.keys()]))
  check('the raw provider sentence never reaches a yield', !anyYieldCarries(r.yields, 'maximum context length is 128000'))
}

// ── R4 ──────────────────────────────────────────────────────────────────────
section('R4 the prune cannot cover a large gap → straight to the fold')
{
  const bigGap: Sig = { ...OPENAI_SIGNAL, actualTokens: 180_000, limitTokens: 128_000 }
  const r = await run({ seed: seedWithReads(8), script: [[ping(), overflowError(bigGap)], [ping(), asstText('folded reply')]], ledger: true })
  check('terminal completed after the fold', r.terminal.reason === 'completed', JSON.stringify(r.terminal))
  check('the fold ran (forced once)', r.compact.filter(c => c.forced !== undefined).length === 1)
  check('the retried request opens on the fold', (r.calls[1]!.messages[0] as AnyMsg).type === 'system')
  check('nothing was pruned first (no placeholder in the retried request)', toolResultsOf(r.calls[1]!.messages).every(x => !isPlaceholder(x.content)))
}

// ── R5 ──────────────────────────────────────────────────────────────────────
section('R5 the switches — DISABLE_AUTO_COMPACT · DISABLE_COMPACT · the flag OFF')
{
  process.env.DISABLE_AUTO_COMPACT = '1'
  const a = await run({ seed: seedPlain(), script: [[ping(), overflowError()]] })
  delete process.env.DISABLE_AUTO_COMPACT
  const aText = textOf(errorYields(a.yields)[0])
  check('auto-compact off: terminal prompt_too_long after ONE call', a.terminal.reason === 'prompt_too_long' && a.calls.length === 1, JSON.stringify(a.terminal))
  check('auto-compact off: the refusal says the emergency fold did not run', aText.includes('automatic compaction is off, so the emergency fold did not run'), aText)
  check('auto-compact off: no fold was forced', a.compact.every(c => c.forced === undefined))

  process.env.DISABLE_COMPACT = '1'
  const b = await run({ seed: seedPlain(), script: [[ping(), overflowError()]] })
  delete process.env.DISABLE_COMPACT
  const bText = textOf(errorYields(b.yields)[0])
  check('compaction off: the refusal names DISABLE_COMPACT', b.terminal.reason === 'prompt_too_long' && bText.includes('compaction is disabled (DISABLE_COMPACT)'), bText)

  process.env.MERCURY_OVERFLOW_RECOVERY = '0'
  const c = await run({ seed: seedPlain(), script: [[ping(), overflowError()]] })
  delete process.env.MERCURY_OVERFLOW_RECOVERY
  check('flag OFF: today\'s surface — the raw error is the settled reply, terminal completed, one call', c.terminal.reason === 'completed' && c.calls.length === 1 && errorYields(c.yields).length === 1 && textOf(errorYields(c.yields)[0]).includes(OPENAI_RAW), JSON.stringify(c.terminal))
  check('flag OFF: nothing withheld, no ladder transition, no notice', !c.events.some(e => e.kind === 'assistant_settled' && e.withheld === true) && !JSON.stringify(settledTransitions(c.events)).includes('overflow_recovery') && noticeTexts(c.yields).length === 0)
}

// ── R6 ──────────────────────────────────────────────────────────────────────
section('R6 the failure breaker — a tripped compaction breaker refuses typed')
{
  const compact = makeCompact({ onThreshold: [{ wasCompacted: false, consecutiveFailures: 3 }] })
  const r = await run({ seed: seedPlain(), script: [[ping(), overflowError()]], compact })
  const text = textOf(errorYields(r.yields)[0])
  check('terminal prompt_too_long after one call', r.terminal.reason === 'prompt_too_long' && r.calls.length === 1, JSON.stringify(r.terminal))
  check('the refusal names the paused compaction', text.includes('compaction has failed repeatedly and is paused for this session'), text)
  check('no fold was forced past the breaker', r.compact.every(c => c.forced === undefined))
}

// ── R7 ──────────────────────────────────────────────────────────────────────
section('R7 mid-tool overflow — the follow-up call after a tool round')
{
  const r = await run({
    seed: seedPlain(),
    script: [[ping(), asstToolUse('toolu_mid_1', 'EchoTool', { text: 'go' })], [ping(), overflowError()], [ping(), asstText('mid-tool reply')]],
  })
  check('terminal completed in three calls', r.terminal.reason === 'completed' && r.calls.length === 3, `${JSON.stringify(r.terminal)} calls=${r.calls.length}`)
  const forced = r.compact.find(c => c.forced !== undefined)
  check('the fold ran once', forced !== undefined && r.compact.filter(c => c.forced !== undefined).length === 1)
  const foldInput = forced?.messages ?? []
  const useAt = foldInput.findIndex(m => (m as AnyMsg).type === 'assistant' && JSON.stringify(((m as AnyMsg).message as { content: unknown }).content).includes('toolu_mid_1'))
  const resultAt = foldInput.findIndex(m => toolResultsOf([m]).some(x => x.id === 'toolu_mid_1'))
  check('the fold input carries the PAIRED round (the tool_use, then its tool_result — a legal boundary)', useAt !== -1 && resultAt === useAt + 1 && !foldInput.some(m => (m as AnyMsg).isApiErrorMessage === true), JSON.stringify(foldInput.map(m => (m as AnyMsg).type)))
  const retry = r.calls[2]!.messages
  const useIds = new Set<string>()
  for (const m of retry as AnyMsg[]) {
    if (m.type !== 'assistant') continue
    for (const b of ((m.message as { content?: AnyMsg[] }).content ?? [])) if (b.type === 'tool_use') useIds.add(String(b.id))
  }
  const resultIds = new Set(toolResultsOf(retry).map(x => x.id))
  check('the retried request carries no unpaired tool_use', [...useIds].every(id => resultIds.has(id)), JSON.stringify([...useIds]))
  check('the retried request opens on the fold and carries no operator tail (the view ended in a tool round)', (retry[0] as AnyMsg).type === 'system' && lastText(retry) !== OPERATOR_ASK)
}

// ── R8 ──────────────────────────────────────────────────────────────────────
section('R8 the estimate side — the blocking preempt prunes or refuses typed')
{
  const seed = seedWithReads(8, 100_000)
  const count = tokenCountWithEstimation(seed as never)
  process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE = String(count - 800)
  const r = await run({ seed, script: [[ping(), asstText('after the prune')]], ledger: true })
  delete process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE
  check('the call proceeded after the prune (one call, terminal completed)', r.terminal.reason === 'completed' && r.calls.length === 1, `${JSON.stringify(r.terminal)} calls=${r.calls.length}`)
  check('the transition names the prune rung from the ESTIMATE', JSON.stringify(settledTransitions(r.events)).includes('"reason":"overflow_recovery","rung":"prune","source":"estimate"'), JSON.stringify(settledTransitions(r.events)))
  const cleared = toolResultsOf(r.calls[0]!.messages).filter(x => isPlaceholder(x.content)).map(x => x.id)
  check('the oldest results were cleared before the call', cleared.length === 3, JSON.stringify(cleared))
  check('the notice names the estimate', noticeTexts(r.yields).some(t => t.startsWith('context overflowed (estimated ') && t.includes('pruned 3 superseded tool results')), JSON.stringify(noticeTexts(r.yields)))

  process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE = '1'
  const x = await run({ seed: seedPlain(), script: [[ping(), asstText('never reached')]] })
  delete process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE
  const xText = textOf(errorYields(x.yields)[0])
  check("refusal: today's terminal blocking_limit, ZERO model calls", x.terminal.reason === 'blocking_limit' && x.calls.length === 0, JSON.stringify(x.terminal))
  check('refusal: the stable content key leads', xText.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE), xText)
  check('refusal: it names the estimate and that the fold did not land', xText.includes('the request is over the window (estimated ') && xText.includes('the fold did not bring the conversation under the window'), xText)
  check('refusal: it carries the estimate signal', overflowSignalOf(errorYields(x.yields)[0] as never)?.source === 'estimate')
}

// ── R9 ──────────────────────────────────────────────────────────────────────
section('R9 service forks never enter the ladder')
{
  const r = await run({ seed: seedPlain(), script: [[ping(), overflowError()]], querySource: 'compact' })
  check('compact source: the raw error surfaces as today (terminal completed, one call)', r.terminal.reason === 'completed' && r.calls.length === 1 && errorYields(r.yields).length === 1 && textOf(errorYields(r.yields)[0]).includes(OPENAI_RAW), JSON.stringify(r.terminal))
  check('compact source: nothing withheld, no fold forced', !r.events.some(e => e.kind === 'assistant_settled' && e.withheld === true) && r.compact.every(c => c.forced === undefined))
}

// ── R10 ─────────────────────────────────────────────────────────────────────
section('R10 the interactive refusal names the slash-command remedies')
{
  const r = await run({ seed: seedPlain(), script: [[ping(), overflowError()], [ping(), overflowError()]], interactive: true })
  const text = textOf(errorYields(r.yields)[0])
  check('/clear and /model are named', text.includes('/clear starts fresh, or /model picks a model with a larger window.'), text)
  process.env.DISABLE_AUTO_COMPACT = '1'
  const a = await run({ seed: seedPlain(), script: [[ping(), overflowError()]], interactive: true })
  delete process.env.DISABLE_AUTO_COMPACT
  const aText = textOf(errorYields(a.yields)[0])
  check('auto-compact off (interactive): /compact by hand is named', aText.includes('/compact folds the conversation by hand'), aText)
}

// ── R11 ─────────────────────────────────────────────────────────────────────
section('R11 the episode law — a completed tool round opens a fresh episode; the thrash breaker stands')
{
  const r = await run({
    seed: seedPlain(),
    script: [
      [ping(), overflowError()],
      [ping(), asstToolUse('toolu_ep_1', 'EchoTool', { text: 'go' })],
      [ping(), overflowError()],
      [ping(), asstText('second fold reply')],
    ],
  })
  check('four calls, terminal completed', r.calls.length === 4 && r.terminal.reason === 'completed', `${r.calls.length} ${JSON.stringify(r.terminal)}`)
  check('two forced folds — the second is a NEW episode after the tool round', r.compact.filter(c => c.forced !== undefined).length === 2)

  const thrash = makeCompact({ onForced: [rigFoldResult(), { wasCompacted: false, rapidRefillBreakerTripped: true }] })
  const t = await run({
    seed: seedPlain(),
    script: [[ping(), overflowError()], [ping(), asstToolUse('toolu_ep_2', 'EchoTool', { text: 'go' })], [ping(), overflowError()], [ping(), asstText('never')]],
    compact: thrash,
  })
  check('the rapid-refill breaker ends the thrash: terminal rapid_refill_breaker', t.terminal.reason === 'rapid_refill_breaker', JSON.stringify(t.terminal))
  check('…with the thrash message, and no fourth call', t.calls.length === 3 && anyYieldCarries(t.yields, AUTOCOMPACT_THRASH_MESSAGE.slice(0, 40)))
}

// ── R12 ─────────────────────────────────────────────────────────────────────
section('R12 the forced fold fails at the head → refusal names the reason, no call on a request known not to fit')
{
  const compact = makeCompact({ onForced: [{ wasCompacted: false, consecutiveFailures: 1, refusal: 'The summary call stalled and was stopped' }] })
  const r = await run({ seed: seedPlain(), script: [[ping(), overflowError()], [ping(), asstText('never')]], compact })
  const text = textOf(errorYields(r.yields)[0])
  check('terminal prompt_too_long after ONE model call', r.terminal.reason === 'prompt_too_long' && r.calls.length === 1, `${JSON.stringify(r.terminal)} calls=${r.calls.length}`)
  check('the refusal names the fold failure with its reason', text.includes('the fold failed (The summary call stalled and was stopped)'), text)
  check('the notice announced the fold before it failed', noticeTexts(r.yields).some(t => t.endsWith('folding the conversation and retrying')))
}

// ── R13 ─────────────────────────────────────────────────────────────────────
section('R13 a lone message larger than the window — nothing to fold')
{
  const r = await run({ seed: [createUserMessage({ content: OPERATOR_ASK })], script: [[ping(), overflowError()]] })
  const text = textOf(errorYields(r.yields)[0])
  check('terminal prompt_too_long after one call, no fold forced', r.terminal.reason === 'prompt_too_long' && r.calls.length === 1 && r.compact.every(c => c.forced === undefined), JSON.stringify(r.terminal))
  check('the refusal says the message alone is larger than the window', text.includes('this message alone is larger than the window — shorten or split it'), text)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
