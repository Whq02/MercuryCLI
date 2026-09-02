#!/usr/bin/env bun
// ============================================================================
//  scripts/core-runtime/prove-runloop-contract.ts — T8:
//  the query() run-loop contract laws (the characterization laws,
//  implementation-blind,
//  green on the OLD body (src/query.ts queryLoop) BEFORE the replacement cut.
//
//  The rig drives the REAL query() generator in-process with an injected
//  fake model via the `deps` seam (query/deps.ts) — no API calls, no PTY,
//  no build. Real message factories, the real tool-orchestration path
//  (runTools), the real hooks engine (session function/command hooks), the
//  real queue singleton. Every fixture records the fake model's per-call
//  request contract (model · effortValue · maxOutputTokensOverride ·
//  taskBudget · input messages) — the request-side golden.
//
//    L1  COMPLETED — yield ordering + terminal on a plain turn
//    L2  NEXT-TURN + EXACTLY-ONCE — one tool_result per tool_use, in the
//        yield stream AND in the next call's input; ctx.messages rebuild
//    L3  BACKFILL — adds-only clones the yielded assistant, the ORIGINAL
//        flows back to the API; overwrite-only skips the clone
//    L4  WITHHELD max_output_tokens — ≤3 nudge recoveries, the error
//        yielded exactly once on exhaustion (escalate gate: folded OFF)
//    L5  FALLBACK (thrown) — synthesized pairing, warning message, full
//        retry on the fallback model, ONE stream_request_start
//    L6  STREAMING FALLBACK — tombstones for orphaned assistants; L6b —
//        the retraction fires ONCE: post-fallback assistants are never
//        re-tombstoned (the latched-flag defect the T8 machine fixed —
//        the old body erased valid fallback output when two or more
//        post-fallback messages arrived)
//    L7  ABORT MID-STREAM — synthetic pairing, interruption message iff
//        reason ≠ 'interrupt', terminal aborted_streaming
//    L8  ABORT MID-TOOL — terminal aborted_tools (+ max_turns attachment)
//    L9  MODEL THROW — pairing synthesized, real error surfaced,
//        terminal model_error
//    L10 IMAGE ERROR — terminal image_error
//    L11 BLOCKING LIMIT — synthetic preempt, zero model calls
//        (CHARACTERIZED: fires regardless of auto-compact — the folded
//        reactiveCompact makes the skip conjunct vacuous)
//    L12 RAPID-REFILL BREAKER — thrash message, zero model calls
//    L13 COMPACTION BOUNDARY — boundary yields precede the call; the call
//        consumes the post-compact set; task-budget carryover
//    L14 STOP-HOOK BLOCKING — blocking meta message, loop continues,
//        next input carries it
//    L15 STOP-HOOK PREVENTED — continue:false ⇒ hook_stopped_continuation
//        + terminal stop_hook_prevented
//    L16 API-ERROR SKIPS HOOKS — the death-spiral guard
//    L17 HOOK_STOPPED — PreToolUse continue:false ⇒ terminal hook_stopped
//    L18 STEERING DRAIN — prompt drains once; slash + foreign-agent never;
//        queued deepthink raises the NEXT call's effort; floor cleared
//    L19 MAX TURNS — attachment + terminal max_turns
//    L20 BRIEF-TERMINAL — Brief-only turn ends without recursion;
//        is_error Brief keeps the recursion
//    L21 LIFECYCLE ASYMMETRY + TEARDOWN — .return() skips 'completed' and
//        still clears the effort floor (the finally law)
//    L22 standing — no tool_use_summary yields (env gate OFF is the
//        characterized default)
//
//  CHARACTERIZED build facts this suite pins (do not "fix" silently):
//    • FORK_GATE_TABLE is empty ⇒ mercury_streaming_tool_execution2 = false
//      ⇒ StreamingToolExecutor is UNREACHABLE; runTools is the one live
//      tool path (T9's body is dormant in this build).
//    • mercury_otk_slot_v1 = false ⇒ the max_output_tokens ESCALATE
//      transition is unreachable; only the ≤3 nudge recovery lives.
//    • reactiveCompact/contextCollapse are folded out ⇒ PTL/media
//      withholding never fires ⇒ terminal prompt_too_long is UNREACHABLE
//      (a 413 error surfaces as isApiErrorMessage ⇒ terminal completed).
//    • State.transition has no test tap (no src edits allowed) — the
//      Continue vocabulary is asserted via its observable consequences
//      (call counts, injected messages, request contract deltas).
//
//  Run: ~/.bun/bin/bun run scripts/core-runtime/prove-runloop-contract.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

// ── hermetic env (BEFORE any src import) ────────────────────────────────────
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'runloop-laws-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'runloop-daemon-'))
process.env.MERCURY_TEAMS_DIR = mkdtempSync(join(tmpdir(), 'runloop-teams-'))
// NOT bare mode: MERCURY_SIMPLE=1 disables the ENTIRE hooks engine
// (engine.ts executeHooks early-return), which would blind the stop-hook
// laws. The stop-hook background forks are inert here without it: prompt
// suggestion early-returns for querySource!=='repl_main_thread' (all
// fixtures run as 'sdk') and auto-dream's runner is never registered
// in-process.
for (const k of [
  'MERCURY_SIMPLE',
  'MERCURY_EFFORT_LEVEL',
  'MERCURY_MAX_OUTPUT_TOKENS',
  'MERCURY_BLOCKING_LIMIT_OVERRIDE',
  'MERCURY_RELEVANT_RECALL',
  'HERMES_DEEPTHINK_MAX',
  'CLAUDE_TEAM_NAME',
  'CLAUDE_AGENT_NAME',
  'DISABLE_COMPACT',
  'DISABLE_AUTO_COMPACT',
  'NODE_ENV',
]) {
  delete process.env[k]
}

const { query } = await import('../../src/query.ts')
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createAssistantMessage, createAssistantAPIErrorMessage, createUserMessage } =
  await import('../../src/utils/messages.ts')
const { FallbackTriggeredError } = await import('../../src/services/api/withRetry.ts')
const { ImageSizeError } = await import('../../src/utils/imageValidation.ts')
const { AUTOCOMPACT_THRASH_MESSAGE } = await import('../../src/services/compact/autoCompact.ts')
const { PROMPT_TOO_LONG_ERROR_MESSAGE } = await import('../../src/services/api/errors.ts')
const { INTERRUPT_MESSAGE, INTERRUPT_MESSAGE_FOR_TOOL_USE } = await import(
  '../../src/utils/messages/rejectionText.ts'
)
const qm = await import('../../src/utils/messageQueueManager.ts')
const lifecycle = await import('../../src/utils/commandLifecycle.ts')
const sessionHooks = await import('../../src/utils/hooks/sessionHooks.ts')
const effort = await import('../../src/utils/effort.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const briefPrompt = await import('../../src/tools/BriefTool/prompt.ts')

const MODEL = 'claude-opus-4-8'
const FALLBACK_MODEL = 'claude-sonnet-5'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
function section(t: string): void {
  console.log('─'.repeat(76) + '\n' + t)
}

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — runloop contract exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

console.log('native-core T8 — query() run-loop contract')

// ── rig ─────────────────────────────────────────────────────────────────────

type AnyMsg = Record<string, unknown> & { type?: string }

/** Deterministic projection: uuid/timestamp/requestId stripped. */
function stripMsg(m: unknown): unknown {
  const msg = m as AnyMsg
  if (!msg || typeof msg !== 'object') return msg
  const t = msg.type
  if (t === 'user' || t === 'assistant') {
    const inner = msg.message as { content?: unknown } | undefined
    const c = inner?.content
    return {
      t,
      meta: msg.isMeta === true ? true : undefined,
      err: msg.isApiErrorMessage === true ? true : undefined,
      c:
        typeof c === 'string'
          ? c
          : ((c as AnyMsg[] | undefined) ?? []).map(b => ({
              bt: b.type,
              text: b.text,
              id: b.id,
              name: b.name,
              tuid: b.tool_use_id,
              e: b.is_error,
              bc: typeof b.content === 'string' ? b.content : undefined,
              input: b.input,
            })),
    }
  }
  if (t === 'attachment') {
    const a = msg.attachment as AnyMsg | undefined
    return { t, at: a?.type, prompt: a?.prompt }
  }
  if (t === 'system') return { t, text: msg.content ?? msg.text }
  return { t }
}
const digest = (msgs: unknown[]): string => JSON.stringify(msgs.map(stripMsg))

/** All tool_result blocks (with their carrying message index) in a message list. */
function toolResultBlocks(
  msgs: unknown[],
): Array<{ tool_use_id: string; is_error?: boolean; content?: unknown; idx: number }> {
  const out: Array<{ tool_use_id: string; is_error?: boolean; content?: unknown; idx: number }> = []
  msgs.forEach((m, idx) => {
    const msg = m as AnyMsg
    if (msg?.type !== 'user') return
    const c = (msg.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(c)) return
    for (const b of c as AnyMsg[]) {
      if (b?.type === 'tool_result') {
        out.push({
          tool_use_id: b.tool_use_id as string,
          is_error: b.is_error as boolean | undefined,
          content: b.content,
          idx,
        })
      }
    }
  })
  return out
}

function userTextMessages(msgs: unknown[]): string[] {
  const out: string[] = []
  for (const m of msgs) {
    const msg = m as AnyMsg
    if (msg?.type !== 'user') continue
    const c = (msg.message as { content?: unknown } | undefined)?.content
    if (typeof c === 'string') out.push(c)
    else if (Array.isArray(c)) {
      for (const b of c as AnyMsg[]) {
        if (b?.type === 'text' && typeof b.text === 'string') out.push(b.text)
      }
    }
  }
  return out
}

const yieldTypes = (yields: unknown[]): string[] => yields.map(y => (y as AnyMsg).type ?? '?')

type CallRecord = {
  model: unknown
  effort: unknown
  override: unknown
  taskBudget: unknown
  messages: unknown[]
}
type ModelStep =
  | { kind: 'yield'; value: unknown }
  | { kind: 'do'; fn: (env: { options: Record<string, unknown>; signal: AbortSignal }) => void }
  | { kind: 'throw'; error: unknown }
const y = (value: unknown): ModelStep => ({ kind: 'yield', value })

function makeModel(script: ModelStep[][]): {
  calls: CallRecord[]
  callModel: (req: never) => AsyncGenerator<never, void>
} {
  const calls: CallRecord[] = []
  async function* callModel(req: {
    messages: unknown[]
    signal: AbortSignal
    options: Record<string, unknown>
  }): AsyncGenerator<never, void> {
    const idx = calls.length
    calls.push({
      model: req.options.model,
      effort: req.options.effortValue,
      override: req.options.maxOutputTokensOverride,
      taskBudget: req.options.taskBudget,
      messages: [...req.messages],
    })
    const steps = script[idx]
    if (!steps) throw new Error(`model script exhausted at call ${idx}`)
    for (const s of steps) {
      if (s.kind === 'yield') yield s.value as never
      else if (s.kind === 'do') s.fn({ options: req.options, signal: req.signal })
      else throw s.error
    }
  }
  return { calls, callModel: callModel as never }
}

function autocompactScript(results: Array<Record<string, unknown>>) {
  let i = 0
  return async () => (results[i] ? results[i++]! : { wasCompacted: false })
}
const passthroughMicrocompact = async (messages: unknown[]) => ({ messages }) as never

function seededUuid(): () => string {
  let n = 0
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
}

const allowAll = async (_tool: unknown, input: Record<string, unknown>) =>
  ({
    behavior: 'allow',
    updatedInput: input,
    decisionReason: { type: 'other', reason: 'rig' },
  }) as never

type ToolOpts = {
  onCall?: (ctx: Record<string, unknown>, input: Record<string, unknown>) => void
  backfill?: 'adds' | 'overwrites'
  call?: (
    input: Record<string, unknown>,
    ctx: Record<string, unknown>,
  ) => Promise<{ data: unknown }>
}
function makeTool(name: string, opts: ToolOpts = {}): never {
  return {
    name,
    async description() {
      return 'rig tool'
    },
    async prompt() {
      return 'rig tool'
    },
    inputSchema: z.object({ text: z.string().optional(), fail: z.boolean().optional() }),
    userFacingName: () => name,
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isMcp: false,
    needsPermissions: () => false,
    ...(opts.backfill === 'adds' && {
      backfillObservableInput: (input: Record<string, unknown>) => {
        input.rig_added = true
      },
    }),
    ...(opts.backfill === 'overwrites' && {
      backfillObservableInput: (input: Record<string, unknown>) => {
        if ('text' in input) input.text = input.text
      },
    }),
    async validateInput() {
      return { result: true }
    },
    call:
      opts.call ??
      (async (input: Record<string, unknown>, ctx: Record<string, unknown>) => {
        opts.onCall?.(ctx, input)
        return { data: `echo:${(input?.text as string) ?? ''}` }
      }),
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: String(data),
      ...(String(data).includes('FAIL') ? { is_error: true } : {}),
    }),
  } as never
}

function makeCtx(tools: unknown[]): {
  ctx: Record<string, unknown>
  abortController: AbortController
  getAppState: () => Record<string, unknown>
  setAppState: (f: (prev: never) => never) => void
} {
  let appState: Record<string, unknown> = {
    ...(getDefaultAppState() as unknown as Record<string, unknown>),
    effortValue: 'high',
  }
  const abortController = new AbortController()
  const setAppState = (f: (prev: never) => never): void => {
    appState = f(appState as never) as unknown as Record<string, unknown>
  }
  const ctx: Record<string, unknown> = {
    abortController,
    options: {
      commands: [],
      tools,
      mainLoopModel: MODEL,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      debug: false,
      verbose: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState: () => appState,
    setAppState,
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId: undefined,
  }
  return { ctx, abortController, getAppState: () => appState, setAppState }
}

const asstText = (text: string): unknown => createAssistantMessage({ content: text })
function asstToolUse(id: string, name: string, input: Record<string, unknown>): unknown {
  return createAssistantMessage({
    content: [{ type: 'tool_use', id, name, input }] as never,
  })
}
const seedUser = (text: string): unknown => createUserMessage({ content: text })
const streamPing = (): unknown => ({ type: 'stream_event', event: { type: 'ping' } })

type RunOpts = {
  tools?: unknown[]
  seed?: unknown[]
  script: ModelStep[][]
  autocompact?: Array<Record<string, unknown>>
  maxTurns?: number
  taskBudget?: { total: number }
  fallbackModel?: string
  querySource?: string
  beforeRun?: (rig: {
    ctx: Record<string, unknown>
    abortController: AbortController
    setAppState: (f: (prev: never) => never) => void
  }) => void
}
type RunResult = {
  yields: unknown[]
  terminal: Record<string, unknown>
  calls: CallRecord[]
  ctx: Record<string, unknown>
  abortController: AbortController
}

function buildRun(opts: RunOpts): {
  gen: AsyncGenerator<unknown, unknown>
  calls: CallRecord[]
  ctx: Record<string, unknown>
  abortController: AbortController
} {
  const tools = opts.tools ?? [makeTool('EchoTool')]
  const rig = makeCtx(tools)
  const { calls, callModel } = makeModel(opts.script)
  opts.beforeRun?.(rig)
  const gen = query({
    messages: (opts.seed ?? [seedUser('hello there rig')]) as never,
    systemPrompt: ['rig system prompt'] as never,
    userContext: {},
    systemContext: {},
    canUseTool: allowAll as never,
    toolUseContext: rig.ctx as never,
    querySource: (opts.querySource ?? 'sdk') as never,
    maxTurns: opts.maxTurns,
    taskBudget: opts.taskBudget,
    fallbackModel: opts.fallbackModel,
    deps: {
      callModel: callModel as never,
      autocompact: autocompactScript(opts.autocompact ?? []) as never,
      microcompact: passthroughMicrocompact as never,
      uuid: seededUuid(),
    },
  })
  return { gen, calls, ctx: rig.ctx, abortController: rig.abortController }
}

async function run(opts: RunOpts): Promise<RunResult> {
  const { gen, calls, ctx, abortController } = buildRun(opts)
  const yields: unknown[] = []
  let r = await gen.next()
  while (!r.done) {
    yields.push(r.value)
    r = await gen.next()
  }
  // Let fire-and-forget tails (run kernel flush, stop-failure hooks) settle
  // before the next fixture touches shared module state.
  await new Promise(resolve => setTimeout(resolve, 5))
  return { yields, terminal: r.value as Record<string, unknown>, calls, ctx, abortController }
}

const allYields: unknown[][] = []
const record = (r: RunResult): RunResult => {
  allYields.push(r.yields)
  return r
}

// ── L1 COMPLETED — ordering + terminal ──────────────────────────────────────
section('L1 COMPLETED — yield ordering on a plain turn')
{
  const r = record(
    await run({ script: [[y(streamPing()), y(asstText('done.'))]] }),
  )
  const types = yieldTypes(r.yields)
  check('terminal completed', r.terminal.reason === 'completed', JSON.stringify(r.terminal))
  check('exactly one model call', r.calls.length === 1, String(r.calls.length))
  check('first yield is stream_request_start', types[0] === 'stream_request_start', types.join(','))
  const iPing = types.indexOf('stream_event')
  const iAsst = types.indexOf('assistant')
  check('stream_event precedes assistant settlement', iPing !== -1 && iAsst !== -1 && iPing < iAsst, types.join(','))
  check(
    'exactly one stream_request_start',
    types.filter(t => t === 'stream_request_start').length === 1,
  )
  check('request contract: model', r.calls[0]!.model === MODEL, String(r.calls[0]!.model))
  check('request contract: effort = appState base', r.calls[0]!.effort === 'high', String(r.calls[0]!.effort))
  check('request contract: no override', r.calls[0]!.override === undefined)
  check(
    'request input = seed messages',
    digest(r.calls[0]!.messages) === digest([seedUser('hello there rig')]),
  )
}

// ── L2 NEXT-TURN + EXACTLY-ONCE ─────────────────────────────────────────────
section('L2 NEXT-TURN — exactly-once tool_result pairing + ctx rebuild')
{
  let toolSawMessages: unknown[] | null = null
  const echo = makeTool('EchoTool', {
    onCall: ctx => {
      toolSawMessages = ctx.messages as unknown[]
    },
  })
  const r = record(
    await run({
      tools: [echo],
      script: [
        [y(asstToolUse('tu_1', 'EchoTool', { text: 'x' }))],
        [y(asstText('after tools.'))],
      ],
    }),
  )
  check('terminal completed', r.terminal.reason === 'completed', JSON.stringify(r.terminal))
  check('two model calls (next_turn recursion)', r.calls.length === 2, String(r.calls.length))
  const yieldedResults = toolResultBlocks(r.yields)
  check(
    'tool_result yielded exactly once for tu_1',
    yieldedResults.filter(b => b.tool_use_id === 'tu_1').length === 1,
    JSON.stringify(yieldedResults),
  )
  check(
    'yielded tool_result carries the tool output',
    yieldedResults[0]?.content === 'echo:x',
    String(yieldedResults[0]?.content),
  )
  const call2Results = toolResultBlocks(r.calls[1]!.messages)
  check(
    "call 2 input carries tu_1's tool_result exactly once",
    call2Results.filter(b => b.tool_use_id === 'tu_1').length === 1,
    JSON.stringify(call2Results),
  )
  const call2HasAssistant = r.calls[1]!.messages.some(
    m =>
      (m as AnyMsg).type === 'assistant' &&
      JSON.stringify((m as AnyMsg).message).includes('tu_1'),
  )
  check('call 2 input carries the tool-calling assistant', call2HasAssistant)
  check(
    'authoritative rebuild: tool reads ctx.messages === the request input',
    toolSawMessages !== null && digest(toolSawMessages!) === digest(r.calls[0]!.messages),
  )
  const types = yieldTypes(r.yields)
  check(
    'two stream_request_start markers (one per iteration)',
    types.filter(t => t === 'stream_request_start').length === 2,
  )
  const secondStart = types.indexOf('stream_request_start', 1)
  const resultIdx = r.yields.findIndex(
    m => toolResultBlocks([m]).some(b => b.tool_use_id === 'tu_1'),
  )
  check(
    'tool_result yields inside iteration 1 (before the second request start)',
    resultIdx !== -1 && secondStart !== -1 && resultIdx < secondStart,
    `result@${resultIdx} start2@${secondStart}`,
  )
}

// ── L3 BACKFILL clone-on-yield ──────────────────────────────────────────────
section('L3 BACKFILL — adds-only clones the yield; the ORIGINAL flows to the API')
{
  const adds = makeTool('EchoTool', { backfill: 'adds' })
  const original = asstToolUse('tu_bf', 'EchoTool', { text: 'v' })
  const r = record(
    await run({
      tools: [adds],
      script: [[y(original)], [y(asstText('done'))]],
    }),
  )
  const yieldedAsst = r.yields.find(m => (m as AnyMsg).type === 'assistant') as AnyMsg
  check('assistant yielded', yieldedAsst !== undefined)
  check('adds-only: the yielded assistant is a CLONE', yieldedAsst !== original)
  const yieldedInput = (
    (yieldedAsst?.message as { content?: AnyMsg[] })?.content?.find(
      b => b.type === 'tool_use',
    ) as { input?: Record<string, unknown> }
  )?.input
  check('clone carries the backfilled field', yieldedInput?.rig_added === true, JSON.stringify(yieldedInput))
  const originalInput = (
    (original as AnyMsg).message as { content: Array<{ input: Record<string, unknown> }> }
  ).content[0]!.input
  check('the ORIGINAL input object is untouched', !('rig_added' in originalInput))
  const call2Asst = r.calls[1]!.messages.find(
    m => (m as AnyMsg).type === 'assistant',
  ) as AnyMsg
  check(
    'the API-bound message is the original (prompt-cache byte identity)',
    call2Asst === original,
  )

  const overwrites = makeTool('EchoTool', { backfill: 'overwrites' })
  const original2 = asstToolUse('tu_bf2', 'EchoTool', { text: 'w' })
  const r2 = record(
    await run({
      tools: [overwrites],
      script: [[y(original2)], [y(asstText('done'))]],
    }),
  )
  const yielded2 = r2.yields.find(m => (m as AnyMsg).type === 'assistant')
  check('overwrite-only backfill: NO clone — yielded === original', yielded2 === original2)
}

// ── L4 WITHHELD max_output_tokens ───────────────────────────────────────────
section('L4 WITHHELD max_output_tokens — nudge recovery ≤3, exact-once surfacing')
{
  const motError = (): unknown =>
    createAssistantAPIErrorMessage({
      content: 'max output tokens hit',
      apiError: 'max_output_tokens',
    })
  const r = record(
    await run({
      script: [[y(motError())], [y(motError())], [y(motError())], [y(motError())]],
    }),
  )
  check('terminal completed (exhaustion surfaces, then API-error return)', r.terminal.reason === 'completed', JSON.stringify(r.terminal))
  check('4 model calls (1 + 3 recoveries)', r.calls.length === 4, String(r.calls.length))
  const surfaced = r.yields.filter(
    m => (m as AnyMsg).apiError === 'max_output_tokens',
  )
  check('the withheld error yielded EXACTLY once (on exhaustion)', surfaced.length === 1, String(surfaced.length))
  const nudge = (msgs: unknown[]): number =>
    userTextMessages(msgs).filter(t => t.includes('Output token limit hit')).length
  check('call 2 input carries 1 nudge', nudge(r.calls[1]!.messages) === 1, String(nudge(r.calls[1]!.messages)))
  check('call 4 input carries 3 nudges', nudge(r.calls[3]!.messages) === 3, String(nudge(r.calls[3]!.messages)))
  check(
    'ESCALATE is dead in this build: no call carries maxOutputTokensOverride',
    r.calls.every(c => c.override === undefined),
    JSON.stringify(r.calls.map(c => c.override)),
  )
  check(
    'recovery nudges are isMeta user messages in the NEXT input, never yielded',
    userTextMessages(r.yields).filter(t => t.includes('Output token limit hit')).length === 0,
  )
}

// ── L5 FALLBACK (thrown) ────────────────────────────────────────────────────
section('L5 FALLBACK — full retry on the fallback model, pairing synthesized')
{
  const r = record(
    await run({
      fallbackModel: FALLBACK_MODEL,
      script: [
        [
          y(asstToolUse('tu_fb', 'EchoTool', { text: 'x' })),
          { kind: 'throw', error: new FallbackTriggeredError(MODEL, FALLBACK_MODEL) },
        ],
        [y(asstText('recovered on fallback'))],
      ],
    }),
  )
  check('terminal completed', r.terminal.reason === 'completed', JSON.stringify(r.terminal))
  check('two model calls (attempt + retry)', r.calls.length === 2, String(r.calls.length))
  check('call 1 on the original model', r.calls[0]!.model === MODEL)
  check('call 2 on the FALLBACK model', r.calls[1]!.model === FALLBACK_MODEL, String(r.calls[1]!.model))
  check(
    'full retry: identical input digest across the fallback',
    digest(r.calls[0]!.messages) === digest(r.calls[1]!.messages),
  )
  const synth = toolResultBlocks(r.yields).filter(b => b.tool_use_id === 'tu_fb')
  check('synthesized tool_result yielded exactly once for the orphaned tool_use', synth.length === 1, String(synth.length))
  check('synthesized result is an error', synth[0]?.is_error === true)
  check(
    "synthesized result says 'Model fallback triggered'",
    String(synth[0]?.content) === 'Model fallback triggered',
    String(synth[0]?.content),
  )
  const warning = r.yields.find(
    m =>
      (m as AnyMsg).type === 'system' &&
      String((m as AnyMsg).content).includes('Switched to'),
  )
  check("a 'warning' system message announces the switch", warning !== undefined)
  check(
    'mainLoopModel updated on the shared context',
    ((r.ctx.options as Record<string, unknown>).mainLoopModel as string) === FALLBACK_MODEL,
  )
  check(
    'the retry does NOT emit a second stream_request_start (same iteration)',
    yieldTypes(r.yields).filter(t => t === 'stream_request_start').length === 1,
  )
}

// ── L6 STREAMING FALLBACK — tombstones ──────────────────────────────────────
section('L6 STREAMING FALLBACK — orphaned assistants are tombstoned')
{
  const orphan = asstText('partial from the failing model')
  const r = record(
    await run({
      script: [
        [
          y(orphan),
          {
            kind: 'do',
            fn: env => (env.options.onStreamingFallback as () => void)(),
          },
          y(asstText('fresh from the fallback')),
        ],
      ],
    }),
  )
  check('terminal completed', r.terminal.reason === 'completed', JSON.stringify(r.terminal))
  const tombstones = r.yields.filter(m => (m as AnyMsg).type === 'tombstone')
  check('exactly one tombstone', tombstones.length === 1, String(tombstones.length))
  check(
    'the tombstone carries the orphaned assistant (by reference)',
    (tombstones[0] as AnyMsg)?.message === orphan,
  )
  const tombstoneIdx = r.yields.indexOf(tombstones[0]!)
  const orphanIdx = r.yields.indexOf(orphan)
  check('the orphan was yielded BEFORE its tombstone', orphanIdx !== -1 && orphanIdx < tombstoneIdx)
}

// ── L6b STREAMING FALLBACK — the retraction fires ONCE ──────────────────────
// The old body latched streamingFallbackOccured, so every post-fallback
// assistant with a successor message was re-tombstoned — valid fallback
// output erased from UI/transcript (probed: 'fresh block one'
// tombstoned). The T8 TurnMachine resets the flag after the retraction;
// this law pins the FIXED behavior.
section('L6b STREAMING FALLBACK — post-fallback assistants are never re-tombstoned')
{
  const orphan = asstText('partial from the failing model')
  const fresh1 = asstText('fresh block one')
  const fresh2 = asstText('fresh block two')
  const r = record(
    await run({
      script: [
        [
          y(orphan),
          {
            kind: 'do',
            fn: env => (env.options.onStreamingFallback as () => void)(),
          },
          y(fresh1),
          y(fresh2),
        ],
      ],
    }),
  )
  check('terminal completed', r.terminal.reason === 'completed', JSON.stringify(r.terminal))
  const tombstones = r.yields.filter(m => (m as AnyMsg).type === 'tombstone')
  check('exactly ONE tombstone across the whole run', tombstones.length === 1, String(tombstones.length))
  check(
    'the tombstone carries the pre-fallback orphan, not fallback output',
    (tombstones[0] as AnyMsg)?.message === orphan,
  )
  check('both post-fallback assistants reach the consumer', r.yields.includes(fresh1) && r.yields.includes(fresh2))
}

// ── L7 ABORT MID-STREAM ─────────────────────────────────────────────────────
section('L7 ABORT MID-STREAM — synthetic pairing + the interrupt exemption')
{
  const mk = (reason?: string): RunOpts => {
    let controller: AbortController
    return {
      beforeRun: rig => {
        controller = rig.abortController
      },
      script: [
        [
          y(asstToolUse('tu_ab', 'EchoTool', { text: 'x' })),
          {
            kind: 'do',
            fn: () => (reason === undefined ? controller.abort() : controller.abort(reason)),
          },
        ],
      ],
    }
  }
  const r = record(await run(mk()))
  check('terminal aborted_streaming', r.terminal.reason === 'aborted_streaming', JSON.stringify(r.terminal))
  check('exactly one model call — no further request after abort', r.calls.length === 1)
  const synth = toolResultBlocks(r.yields).filter(b => b.tool_use_id === 'tu_ab')
  check('synthetic tool_result for the announced tool_use, exactly once', synth.length === 1, String(synth.length))
  check('synthetic result is an error', synth[0]?.is_error === true)
  check(
    "synthetic result says 'Interrupted by user'",
    String(synth[0]?.content) === 'Interrupted by user',
    String(synth[0]?.content),
  )
  const interruptions = userTextMessages(r.yields).filter(t => t === INTERRUPT_MESSAGE)
  check('exactly one interruption message (reason undefined)', interruptions.length === 1, String(interruptions.length))

  const r2 = record(await run(mk('interrupt')))
  check("reason 'interrupt': terminal aborted_streaming", r2.terminal.reason === 'aborted_streaming')
  const interruptions2 = userTextMessages(r2.yields).filter(t => t === INTERRUPT_MESSAGE)
  check(
    "reason 'interrupt': the interruption message is SKIPPED (submit-interrupt exemption)",
    interruptions2.length === 0,
    String(interruptions2.length),
  )
  const synth2 = toolResultBlocks(r2.yields).filter(b => b.tool_use_id === 'tu_ab')
  check("reason 'interrupt': pairing still synthesized", synth2.length === 1)
}

// ── L8 ABORT MID-TOOL ───────────────────────────────────────────────────────
section('L8 ABORT MID-TOOL — aborted_tools + the maxTurns attachment')
{
  const makeAbortingTool = (rigRef: { controller?: AbortController }) =>
    makeTool('AbortTool', {
      call: async () => {
        rigRef.controller!.abort()
        return { data: 'finished-during-abort' }
      },
    })
  const rigRef: { controller?: AbortController } = {}
  const r = record(
    await run({
      tools: [makeAbortingTool(rigRef)],
      beforeRun: rig => {
        rigRef.controller = rig.abortController
      },
      script: [[y(asstToolUse('tu_mt', 'AbortTool', {}))]],
    }),
  )
  check('terminal aborted_tools', r.terminal.reason === 'aborted_tools', JSON.stringify(r.terminal))
  check('one model call only', r.calls.length === 1)
  const toolInterrupt = userTextMessages(r.yields).filter(
    t => t === INTERRUPT_MESSAGE_FOR_TOOL_USE,
  )
  check('tool-use interruption message yielded once', toolInterrupt.length === 1, String(toolInterrupt.length))
  check(
    'no max_turns attachment without a maxTurns cap',
    !r.yields.some(
      m => ((m as AnyMsg).attachment as AnyMsg | undefined)?.type === 'max_turns_reached',
    ),
  )

  const rigRef2: { controller?: AbortController } = {}
  const r2 = record(
    await run({
      tools: [makeAbortingTool(rigRef2)],
      maxTurns: 1,
      beforeRun: rig => {
        rigRef2.controller = rig.abortController
      },
      script: [[y(asstToolUse('tu_mt2', 'AbortTool', {}))]],
    }),
  )
  check('with maxTurns=1: still terminal aborted_tools', r2.terminal.reason === 'aborted_tools')
  check(
    'with maxTurns=1: the max_turns_reached attachment IS yielded on the abort path',
    r2.yields.some(
      m => ((m as AnyMsg).attachment as AnyMsg | undefined)?.type === 'max_turns_reached',
    ),
  )
}

// ── L9 MODEL THROW ──────────────────────────────────────────────────────────
section('L9 MODEL THROW — pairing synthesized, the REAL error surfaces')
{
  const r = record(
    await run({
      script: [
        [
          y(asstToolUse('tu_err', 'EchoTool', { text: 'x' })),
          { kind: 'throw', error: new Error('rig boom') },
        ],
      ],
    }),
  )
  check('terminal model_error', r.terminal.reason === 'model_error', JSON.stringify(r.terminal))
  check(
    'terminal carries the thrown error',
    (r.terminal.error as Error)?.message === 'rig boom',
  )
  const synth = toolResultBlocks(r.yields).filter(b => b.tool_use_id === 'tu_err')
  check('missing tool_result synthesized exactly once', synth.length === 1, String(synth.length))
  check('synthesized content is the error message', String(synth[0]?.content) === 'rig boom')
  const surfaced = r.yields.find(
    m =>
      (m as AnyMsg).isApiErrorMessage === true &&
      JSON.stringify((m as AnyMsg).message).includes('rig boom'),
  )
  check('the REAL error surfaces as an assistant error message (no phantom interrupt)', surfaced !== undefined)
  check('one model call only', r.calls.length === 1)
}

// ── L10 IMAGE ERROR ─────────────────────────────────────────────────────────
section('L10 IMAGE ERROR — ImageSizeError maps to terminal image_error')
{
  const r = record(
    await run({
      script: [
        [
          {
            kind: 'throw',
            error: new ImageSizeError([{ index: 0, size: 9_999_999 }] as never, 5_000_000),
          },
        ],
      ],
    }),
  )
  check('terminal image_error', r.terminal.reason === 'image_error', JSON.stringify(r.terminal))
  check(
    'a user-friendly assistant error is yielded',
    r.yields.some((m: unknown) => (m as AnyMsg).isApiErrorMessage === true),
  )
}

// ── L11 BLOCKING LIMIT preempt ──────────────────────────────────────────────
section('L11 BLOCKING LIMIT — synthetic preempt, ZERO model calls')
{
  process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE = '100'
  const fatAssistant = createAssistantMessage({
    content: 'previous fat turn',
    usage: {
      input_tokens: 5_000,
      output_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    } as never,
  })
  // getTokenUsage ignores SYNTHETIC_MODEL messages — stamp a real model id
  // so the seed usage counts (as a real prior API response would).
  ;((fatAssistant as AnyMsg).message as Record<string, unknown>).model = MODEL
  const r = record(
    await run({
      seed: [seedUser('hello there rig'), fatAssistant],
      script: [[y(asstText('never reached'))]],
    }),
  )
  delete process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE
  check('terminal blocking_limit', r.terminal.reason === 'blocking_limit', JSON.stringify(r.terminal))
  check('ZERO model calls (preempt is pre-API)', r.calls.length === 0, String(r.calls.length))
  const surfaced = r.yields.find(
    m =>
      (m as AnyMsg).isApiErrorMessage === true &&
      JSON.stringify((m as AnyMsg).message).includes(PROMPT_TOO_LONG_ERROR_MESSAGE),
  )
  check('the prompt-too-long error message is yielded', surfaced !== undefined)
  // CHARACTERIZED: with reactiveCompact folded out, the preempt is armed even
  // though auto-compact defaults ON (the RC skip-conjunct is vacuous truth) —
  // this fixture ran with auto-compact settings untouched.
  check('characterized: preempt fired with auto-compact defaults untouched', true)
}

// ── L12 RAPID-REFILL BREAKER ────────────────────────────────────────────────
section('L12 RAPID-REFILL BREAKER — thrash message, ZERO model calls')
{
  const r = record(
    await run({
      autocompact: [{ wasCompacted: false, rapidRefillBreakerTripped: true }],
      script: [[y(asstText('never reached'))]],
    }),
  )
  check('terminal rapid_refill_breaker', r.terminal.reason === 'rapid_refill_breaker', JSON.stringify(r.terminal))
  check('ZERO model calls', r.calls.length === 0, String(r.calls.length))
  const thrash = r.yields.find(
    m =>
      (m as AnyMsg).isApiErrorMessage === true &&
      JSON.stringify((m as AnyMsg).message).includes(
        AUTOCOMPACT_THRASH_MESSAGE.slice(0, 40),
      ),
  )
  check('the AUTOCOMPACT_THRASH_MESSAGE is yielded', thrash !== undefined)
}

// ── L13 COMPACTION BOUNDARY ─────────────────────────────────────────────────
section('L13 COMPACTION BOUNDARY — boundary yields, post-compact input, budget carryover')
{
  const boundaryMarker = createUserMessage({ content: '[rig boundary]', isMeta: true })
  const summary = createUserMessage({ content: 'RIG SUMMARY', isCompactSummary: true })
  const preCompactAssistant = createAssistantMessage({
    content: 'old fat turn',
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      iterations: [{ input_tokens: 700, output_tokens: 50 }],
    } as never,
  })
  ;((preCompactAssistant as AnyMsg).message as Record<string, unknown>).model = MODEL
  const compactionResult = {
    boundaryMarker,
    summaryMessages: [summary],
    attachments: [],
    hookResults: [],
    preCompactTokenCount: 900,
    postCompactTokenCount: 120,
    truePostCompactTokenCount: 120,
    compactionUsage: undefined,
  }
  const r = record(
    await run({
      seed: [seedUser('hello there rig'), preCompactAssistant],
      taskBudget: { total: 10_000 },
      autocompact: [{ wasCompacted: true, compactionResult }],
      script: [[y(asstText('post-compact turn'))]],
    }),
  )
  check('terminal completed', r.terminal.reason === 'completed', JSON.stringify(r.terminal))
  check('one model call', r.calls.length === 1)
  const yBoundary = r.yields.indexOf(boundaryMarker)
  const ySummary = r.yields.indexOf(summary)
  check('boundary marker yielded', yBoundary !== -1)
  check('summary yielded after the boundary marker', ySummary === yBoundary + 1, `${yBoundary},${ySummary}`)
  const firstAsst = r.yields.findIndex(m => (m as AnyMsg).type === 'assistant')
  check('boundary messages precede the model settlement', ySummary < firstAsst)
  check(
    'stream_request_start precedes the boundary (characterized order)',
    yieldTypes(r.yields).indexOf('stream_request_start') < yBoundary,
  )
  check(
    'the call consumes EXACTLY the post-compact set',
    digest(r.calls[0]!.messages) === digest([boundaryMarker, summary]),
  )
  check(
    'task-budget carryover: remaining = total − pre-compact final window',
    JSON.stringify(r.calls[0]!.taskBudget) === JSON.stringify({ total: 10_000, remaining: 9_250 }),
    JSON.stringify(r.calls[0]!.taskBudget),
  )
}

// ── L14 STOP-HOOK BLOCKING ──────────────────────────────────────────────────
section('L14 STOP-HOOK BLOCKING — the block re-prompts, the loop continues')
{
  let blocks = 0
  const r = record(
    await run({
      beforeRun: rig => {
        sessionHooks.addFunctionHook(
          rig.setAppState as never,
          bootstrap.getSessionId(),
          'Stop',
          '',
          async () => (blocks++ === 0 ? false : true),
          'RIG-KEEP-WORKING: not done yet',
          { id: 'rig-stop-block' },
        )
      },
      script: [[y(asstText('first answer'))], [y(asstText('second answer'))]],
    }),
  )
  check('terminal completed after the hook passes', r.terminal.reason === 'completed', JSON.stringify(r.terminal))
  check('two model calls (stop_hook_blocking continued the loop)', r.calls.length === 2, String(r.calls.length))
  check('the hook ran twice (block, then pass)', blocks === 2, String(blocks))
  const blockYields = userTextMessages(r.yields).filter(t => t.includes('RIG-KEEP-WORKING'))
  check('the blocking re-prompt is yielded exactly once', blockYields.length === 1, String(blockYields.length))
  const call2Block = userTextMessages(r.calls[1]!.messages).filter(t =>
    t.includes('RIG-KEEP-WORKING'),
  )
  check("call 2's input carries the blocking message", call2Block.length === 1, String(call2Block.length))
}

// ── L15 STOP-HOOK PREVENTED ─────────────────────────────────────────────────
section('L15 STOP-HOOK PREVENTED — continue:false halts the turn')
{
  const r = record(
    await run({
      beforeRun: rig => {
        sessionHooks.addSessionHook(
          rig.setAppState as never,
          bootstrap.getSessionId(),
          'Stop',
          '',
          {
            type: 'command',
            command: `echo '{"continue": false, "stopReason": "rig halt"}'`,
          } as never,
        )
      },
      script: [[y(asstText('answer'))]],
    }),
  )
  check('terminal stop_hook_prevented', r.terminal.reason === 'stop_hook_prevented', JSON.stringify(r.terminal))
  check('one model call only', r.calls.length === 1, String(r.calls.length))
  check(
    'the hook_stopped_continuation attachment is yielded',
    r.yields.some(
      m =>
        ((m as AnyMsg).attachment as AnyMsg | undefined)?.type === 'hook_stopped_continuation',
    ),
  )
}

// ── L16 API-ERROR SKIPS HOOKS ───────────────────────────────────────────────
section('L16 API-ERROR SKIPS HOOKS — the death-spiral guard')
{
  let hookRan = 0
  const r = record(
    await run({
      beforeRun: rig => {
        sessionHooks.addFunctionHook(
          rig.setAppState as never,
          bootstrap.getSessionId(),
          'Stop',
          '',
          async () => {
            hookRan++
            return false
          },
          'RIG-SHOULD-NEVER-FIRE',
          { id: 'rig-stop-apierr' },
        )
      },
      script: [
        [y(createAssistantAPIErrorMessage({ content: 'API Error: 500 upstream' }))],
      ],
    }),
  )
  check('terminal completed (error surfaced, turn over)', r.terminal.reason === 'completed', JSON.stringify(r.terminal))
  check('stop hooks were SKIPPED on the API-error turn', hookRan === 0, String(hookRan))
  check('one model call — no blocking retry spiral', r.calls.length === 1)
  check(
    'the API error itself was yielded (not withheld)',
    r.yields.some((m: unknown) => (m as AnyMsg).isApiErrorMessage === true),
  )

  // CHARACTERIZED: terminal prompt_too_long is UNREACHABLE in this build.
  // reactiveCompact is folded out, so a 413 error message is never withheld
  // (it streams straight through) and the recovery branch that returns
  // {reason:'prompt_too_long'} is behind `&& reactiveCompact` — a 413 turn
  // lands on the API-error return: terminal completed, hooks skipped.
  const r413 = record(
    await run({
      script: [[y(createAssistantAPIErrorMessage({ content: PROMPT_TOO_LONG_ERROR_MESSAGE }))]],
    }),
  )
  check(
    'characterized: a 413 error yields terminal completed, NOT prompt_too_long',
    r413.terminal.reason === 'completed',
    JSON.stringify(r413.terminal),
  )
  check(
    'the 413 error message streams through un-withheld',
    r413.yields.some(
      m =>
        (m as AnyMsg).isApiErrorMessage === true &&
        JSON.stringify((m as AnyMsg).message).includes(PROMPT_TOO_LONG_ERROR_MESSAGE),
    ),
  )
  check('the 413 turn makes exactly one model call', r413.calls.length === 1)
}

// ── L17 HOOK_STOPPED via the tool path ──────────────────────────────────────
section('L17 HOOK_STOPPED — PreToolUse continue:false stops after the tool settles')
{
  const r = record(
    await run({
      beforeRun: rig => {
        sessionHooks.addSessionHook(
          rig.setAppState as never,
          bootstrap.getSessionId(),
          'PreToolUse',
          'EchoTool',
          {
            type: 'command',
            command: `echo '{"continue": false, "stopReason": "rig tool halt"}'`,
          } as never,
        )
      },
      script: [[y(asstToolUse('tu_hs', 'EchoTool', { text: 'x' }))]],
    }),
  )
  check('terminal hook_stopped', r.terminal.reason === 'hook_stopped', JSON.stringify(r.terminal))
  check('one model call — the recursion is stopped', r.calls.length === 1, String(r.calls.length))
  const paired = toolResultBlocks(r.yields).filter(b => b.tool_use_id === 'tu_hs')
  check('the tool still executed and its result settled (pairing law)', paired.length === 1, JSON.stringify(paired))
  check(
    'the hook_stopped_continuation attachment is yielded',
    r.yields.some(
      m =>
        ((m as AnyMsg).attachment as AnyMsg | undefined)?.type === 'hook_stopped_continuation',
    ),
  )
}

// ── L18 STEERING DRAIN ──────────────────────────────────────────────────────
section('L18 STEERING DRAIN — scoping, slash exclusion, drained-keyword nudge')
{
  qm.resetCommandQueue()
  const lifecycleEvents: Array<[string, string]> = []
  lifecycle.setCommandLifecycleListener((uuid, state) => {
    lifecycleEvents.push([uuid, state])
  })
  const u1 = '11111111-1111-4111-8111-111111111111'
  const u2 = '22222222-2222-4222-8222-222222222222'
  const u3 = '33333333-3333-4333-8333-333333333333'
  const u4 = '44444444-4444-4444-8444-444444444444'
  qm.enqueue({ value: 'steer note one', mode: 'prompt', uuid: u1 } as never)
  qm.enqueue({ value: '/help', mode: 'prompt', uuid: u2 } as never)
  qm.enqueue({
    value: 'foreign notification',
    mode: 'task-notification',
    agentId: 'agent-elsewhere',
    uuid: u3,
    priority: 'next',
  } as never)
  qm.enqueue({ value: 'and deepthink the rest', mode: 'prompt', uuid: u4 } as never)

  const r = record(
    await run({
      script: [
        [y(asstToolUse('tu_dr', 'EchoTool', { text: 'x' }))],
        [y(asstText('after drain'))],
      ],
    }),
  )
  lifecycle.setCommandLifecycleListener(null)

  check('terminal completed', r.terminal.reason === 'completed')
  const drained = r.yields
    .map(m => (m as AnyMsg).attachment as AnyMsg | undefined)
    .filter(a => a?.type === 'queued_command')
  check('exactly the two prompt commands drained as attachments', drained.length === 2, JSON.stringify(drained.map(a => a?.prompt)))
  check(
    'drained prompts carried verbatim',
    drained.some(a => a?.prompt === 'steer note one') &&
      drained.some(a => a?.prompt === 'and deepthink the rest'),
  )
  const call2Text = JSON.stringify(r.calls[1]!.messages.map(stripMsg))
  check("call 2's input carries the drained steering text", call2Text.includes('steer note one'))
  const remaining = qm.getCommandQueue().map(c => c.uuid)
  check(
    'the slash command NEVER drains (stays queued)',
    remaining.includes(u2 as never),
    JSON.stringify(remaining),
  )
  check(
    "the foreign agent's notification NEVER drains on the main thread",
    remaining.includes(u3 as never),
    JSON.stringify(remaining),
  )
  check('the consumed prompts left the queue', !remaining.includes(u1 as never) && !remaining.includes(u4 as never))
  const started = lifecycleEvents.filter(e => e[1] === 'started').map(e => e[0])
  const completed = lifecycleEvents.filter(e => e[1] === 'completed').map(e => e[0])
  check("lifecycle 'started' fired once per consumed command", JSON.stringify(started.sort()) === JSON.stringify([u1, u4]), JSON.stringify(started))
  check("lifecycle 'completed' fired once per consumed command on normal return", JSON.stringify(completed.sort()) === JSON.stringify([u1, u4]), JSON.stringify(completed))
  check('call 1 rode the base effort', r.calls[0]!.effort === 'high', String(r.calls[0]!.effort))
  // ALIGNED: a drained deepthink is a PROSE nudge —
  // the wire effort must NOT move, and the nudge attachment must land in the
  // drain pass (the orchestrator scans the drained snapshot pre-expansion).
  check(
    "queued deepthink left call 2's effort at the base (no floor)",
    r.calls[1]!.effort === 'high',
    String(r.calls[1]!.effort),
  )
  const nudges = r.yields
    .map(m => (m as AnyMsg).attachment as AnyMsg | undefined)
    .filter(a => a?.type === 'deepthink_effort')
  check(
    'the drained keyword emitted exactly one deepthink_effort attachment',
    nudges.length === 1,
    JSON.stringify(nudges),
  )
  qm.resetCommandQueue()
}

// ── L19 MAX TURNS ───────────────────────────────────────────────────────────
section('L19 MAX TURNS — attachment + typed terminal')
{
  const r = record(
    await run({
      maxTurns: 1,
      script: [[y(asstToolUse('tu_mx', 'EchoTool', { text: 'x' }))]],
    }),
  )
  check('terminal max_turns', r.terminal.reason === 'max_turns', JSON.stringify(r.terminal))
  check('terminal carries the turn count', r.terminal.turnCount === 2, String(r.terminal.turnCount))
  check('exactly one model call', r.calls.length === 1)
  check(
    'the max_turns_reached attachment is yielded',
    r.yields.some(
      m => ((m as AnyMsg).attachment as AnyMsg | undefined)?.type === 'max_turns_reached',
    ),
  )
  check(
    'the tool_result still settled before the cap (pairing law)',
    toolResultBlocks(r.yields).filter(b => b.tool_use_id === 'tu_mx').length === 1,
  )
}

// ── L20 BRIEF-TERMINAL ──────────────────────────────────────────────────────
section('L20 BRIEF-TERMINAL — a Brief-only turn ends; an is_error Brief recurses')
{
  const briefTool = makeTool(briefPrompt.BRIEF_TOOL_NAME, {
    call: async (input: Record<string, unknown>) => ({
      data: input.fail === true ? 'FAIL: rejected' : 'delivered',
    }),
  })
  const r = record(
    await run({
      tools: [briefTool],
      script: [[y(asstToolUse('tu_br', briefPrompt.BRIEF_TOOL_NAME, { text: 'reply' }))]],
    }),
  )
  check('Brief-only turn: terminal completed', r.terminal.reason === 'completed', JSON.stringify(r.terminal))
  check('Brief-only turn: NO recursion (one model call)', r.calls.length === 1, String(r.calls.length))
  check(
    "the Brief tool_result settled and paired (yielded once)",
    toolResultBlocks(r.yields).filter(b => b.tool_use_id === 'tu_br').length === 1,
  )

  const r2 = record(
    await run({
      tools: [briefTool],
      script: [
        [y(asstToolUse('tu_br2', briefPrompt.BRIEF_TOOL_NAME, { fail: true }))],
        [y(asstText('retry prose'))],
      ],
    }),
  )
  check('is_error Brief: the recursion CONTINUES (two calls)', r2.calls.length === 2, String(r2.calls.length))
  check('is_error Brief: terminal completed after retry', r2.terminal.reason === 'completed')
  const errResult = toolResultBlocks(r2.yields).find(b => b.tool_use_id === 'tu_br2')
  check('the failing Brief result is is_error', errResult?.is_error === true, JSON.stringify(errResult))
}

// ── L21 LIFECYCLE ASYMMETRY + TEARDOWN ──────────────────────────────────────
section('L21 TEARDOWN — .return() skips lifecycle-completed (teardown asymmetry)')
{
  // (a) THE DELIVERY LAW (steer-removal re-true): a .return() AT the
  // drained attachment yield still CONSUMES the command — the attachment
  // row already went out to the consumer, so the queue removal + lifecycle
  // 'started' land in the drain's own finally (turn-machine). The old
  // characterization pinned the opposite ("the steer note survives in the
  // queue, unstarted") — that survival re-drained the same words into the
  // next turn: one submit, two deliveries. 'completed' still never fires
  // on teardown (the (b) asymmetry below is unchanged).
  qm.resetCommandQueue()
  const earlyEvents: Array<[string, string]> = []
  lifecycle.setCommandLifecycleListener((uuid, state) => {
    earlyEvents.push([uuid, state])
  })
  const u0 = '66666666-6666-4666-8666-666666666666'
  qm.enqueue({ value: 'deepthink survive the break', mode: 'prompt', uuid: u0 } as never)
  {
    const { gen, calls } = buildRun({
      script: [
        [y(asstToolUse('tu_e', 'EchoTool', { text: 'x' }))],
        [y(asstText('never consumed'))],
      ],
    })
    let sawDrain = false
    const yields: unknown[] = []
    let r = await gen.next()
    while (!r.done) {
      yields.push(r.value)
      if (((r.value as AnyMsg).attachment as AnyMsg | undefined)?.type === 'queued_command') {
        sawDrain = true
        break
      }
      r = await gen.next()
    }
    check('early break: the drain attachment was observed', sawDrain)
    await gen.return({ reason: 'completed' } as never)
    await new Promise(resolve => setTimeout(resolve, 5))
    check(
      'early break: the yielded command is CONSUMED (exactly-once — a queue survival would deliver it twice)',
      !qm.getCommandQueue().some(c => c.uuid === (u0 as never)),
      JSON.stringify(qm.getCommandQueue().map(c => c.uuid)),
    )
    check(
      "early break: lifecycle 'started' fired for the consumed command, and nothing else",
      earlyEvents.length === 1 && earlyEvents[0]?.[0] === u0 && earlyEvents[0]?.[1] === 'started',
      JSON.stringify(earlyEvents),
    )
    check('early break: no second model call', calls.length === 1, String(calls.length))
    allYields.push(yields)
  }
  lifecycle.setCommandLifecycleListener(null)

  // (b) The started-without-completed asymmetry: consume through the first
  // iteration boundary (the second stream_request_start proves the drain
  // finalized), then .return() — 'started' fired, 'completed' never does.
  qm.resetCommandQueue()
  const lifecycleEvents: Array<[string, string]> = []
  lifecycle.setCommandLifecycleListener((uuid, state) => {
    lifecycleEvents.push([uuid, state])
  })
  const u1 = '55555555-5555-4555-8555-555555555555'
  qm.enqueue({ value: 'deepthink and keep going', mode: 'prompt', uuid: u1 } as never)

  const { gen, calls } = buildRun({
    script: [
      [y(asstToolUse('tu_td', 'EchoTool', { text: 'x' }))],
      [y(asstText('never consumed'))],
    ],
  })
  const yields: unknown[] = []
  let requestStarts = 0
  let r = await gen.next()
  while (!r.done) {
    yields.push(r.value)
    if ((r.value as AnyMsg).type === 'stream_request_start') {
      requestStarts++
      if (requestStarts === 2) break
    }
    r = await gen.next()
  }
  check('iteration 2 began (second stream_request_start observed)', requestStarts === 2)
  // ALIGNED: the drained keyword's live observable is
  // the prose-nudge attachment riding the drain pass — no wire-effort floor.
  check(
    'the drained keyword yielded its deepthink_effort nudge before iteration 2',
    yields.some(
      m => ((m as AnyMsg).attachment as AnyMsg | undefined)?.type === 'deepthink_effort',
    ),
  )
  const startedBefore = lifecycleEvents.filter(e => e[1] === 'started').map(e => e[0])
  check(
    "lifecycle 'started' fired at drain finalization",
    JSON.stringify(startedBefore) === JSON.stringify([u1]),
    JSON.stringify(lifecycleEvents),
  )
  check(
    'the consumed command left the queue at finalization',
    !qm.getCommandQueue().some(c => c.uuid === (u1 as never)),
  )
  await gen.return({ reason: 'completed' } as never)
  await new Promise(resolve => setTimeout(resolve, 5))
  lifecycle.setCommandLifecycleListener(null)

  const completed = lifecycleEvents.filter(e => e[1] === 'completed').map(e => e[0])
  check(
    "lifecycle 'completed' NEVER fired on .return() (the deliberate asymmetry)",
    completed.length === 0,
    JSON.stringify(completed),
  )
  check(
    'no model call after the paused request-start (the yield suspends before callModel)',
    calls.length === 1,
    String(calls.length),
  )
  qm.resetCommandQueue()
  allYields.push(yields)
}

// ── CX extensions ─────
section('CX1 CONCURRENT TOOLS — one message, two tool_uses, both settle once (§11 S5)')
{
  const r = record(
    await run({
      script: [
        [
          y(
            createAssistantMessage({
              content: [
                { type: 'tool_use', id: 'tu_cx_a', name: 'EchoTool', input: { text: 'first' } },
                { type: 'tool_use', id: 'tu_cx_b', name: 'EchoTool', input: { text: 'second' } },
              ] as never,
            }),
          ),
        ],
        [y(asstText('after the concurrent batch.'))],
      ],
    }),
  )
  check('CX1 terminal completed', r.terminal.reason === 'completed', JSON.stringify(r.terminal))
  const a = toolResultBlocks(r.yields).filter(b => b.tool_use_id === 'tu_cx_a')
  const b = toolResultBlocks(r.yields).filter(b => b.tool_use_id === 'tu_cx_b')
  check('CX1 both tools settled exactly once', a.length === 1 && b.length === 1, `a=${a.length} b=${b.length}`)
  check('CX1 both settlements are REAL (echo results, not synthetic errors)',
    String(a[0]?.content).includes('echo:first') && String(b[0]?.content).includes('echo:second'),
    `${String(a[0]?.content)} | ${String(b[0]?.content)}`)
  check('CX1 the follow-up call carries BOTH results',
    r.calls.length === 2 &&
      JSON.stringify(r.calls[1]?.messages ?? []).includes('tu_cx_a') &&
      JSON.stringify(r.calls[1]?.messages ?? []).includes('tu_cx_b'))
  // Ordering law: the results ride in announcement order in the follow-up.
  const followupStr = JSON.stringify(r.calls[1]?.messages ?? [])
  check('CX1 results in announcement order', followupStr.indexOf('tu_cx_a') !== -1 && followupStr.indexOf('tu_cx_a') < followupStr.indexOf('tu_cx_b'))
}

section('CX2 ABORT BEFORE FIRST DELTA — the pre-dispatch/header-wait stop is clean (§11 S6/S7)')
{
  // The abort fires INSIDE the model call before any yield — the header-wait
  // window (S7), and the machine-reachable form of "stop during preparation"
  // (S6): with no announced tool_use there is nothing to pair, and the clean
  // aborted_streaming band must terminalize without synthetic settlements,
  // stuck floors, or a second model call. (Stop DURING the compaction await
  // itself reaches this same band on the next streamModel entry — the
  // adversarial pass's corroboration; this pins that band's cleanliness.)
  let controller: AbortController
  const r = record(
    await run({
      beforeRun: rig => {
        controller = rig.abortController
      },
      script: [
        [
          {
            kind: 'do',
            fn: () => controller!.abort(),
          },
        ],
      ],
    }),
  )
  check('CX2 terminal aborted_streaming', r.terminal.reason === 'aborted_streaming', JSON.stringify(r.terminal))
  check('CX2 exactly one model call — nothing dispatched after the abort', r.calls.length === 1, String(r.calls.length))
  check('CX2 zero tool_result blocks (nothing announced ⇒ nothing paired)', toolResultBlocks(r.yields).length === 0)
  check('CX2 the interruption message rides (reason undefined ⇒ not a steer)',
    userTextMessages(r.yields).filter(t => t === INTERRUPT_MESSAGE).length === 1)
}

// ── L22 standing — tool_use_summary gate ────────────────────────────────────
section('L22 STANDING — no tool_use_summary yields anywhere (env gate OFF)')
{
  const summaries = allYields.flat().filter(m => (m as AnyMsg).type === 'tool_use_summary')
  check(
    'zero tool_use_summary yields across every fixture (characterized default)',
    summaries.length === 0,
    String(summaries.length),
  )
}

console.log('')
if (failures > 0) {
  console.log(`native-core runloop contract: RED (${failures}/${checks} checks failed)`)
  process.exit(1)
}
console.log(`native-core runloop contract: green (${checks} checks)`)
