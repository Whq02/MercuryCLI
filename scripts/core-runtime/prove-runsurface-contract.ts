#!/usr/bin/env bun
// ============================================================================
//  scripts/core-runtime/prove-runsurface-contract.ts —
// the run-SURFACE contract laws (the characterization laws,
//  implementation-blind,
//  green on the OLD bodies BEFORE the replacement cuts:
//
//    QueryEngine (src/QueryEngine.ts submitMessage) — the SDK/headless
//        ENGINE projection: what each query() yield becomes on the SDK
//        stream, and the result envelope it synthesizes at the end.
//    print/headless (src/cli/print.ts + src/cli/headless/*) — the
//        in-process-reachable PRINT contracts: input batching, resume
//        cleanup, the control-protocol permission-mode handler, the
//        permission-channel resolver.
//    stream projections (src/utils/messages/streaming.ts) — the
//        interactive projection handleMessageFromStream + the late-frame
//        drop predicate, plus the PROJECTION-EQUIVALENCE leg: one recorded
//        REAL query() yield sequence fed through the interactive projection
//        AND replayed through the QueryEngine (the staged law).
//
//  T8's laws live in prove-runloop-contract.ts (140 checks) — NOT duplicated
//  here. The rig REUSES its patterns: hermetic env dirs, scripted fake
//  callModel via params.deps for the one real-query leg, real message
//  factories, check() counters.
//
//  THE RIG SEAM: QueryEngine.submitMessage calls query() WITHOUT the
//  deps injection (src/QueryEngine.ts:835-846 — deps is not plumbed), so the
//  engine cannot be driven through params.deps. The rig mocks the query
//  MODULE (bun:test mock.module, registered before the QueryEngine import)
//  with a dispatcher: fixtures script the query() yields directly; when no
//  script is active the dispatcher delegates to the REAL query captured
//  before the mock (the S10/X1 equivalence legs).
//
//  Law families:
//    R1  T9 REACHABILITY PIN — mercury_streaming_tool_execution2 is FALSE
//        (FORK_GATE_TABLE empty) ⇒ StreamingToolExecutor stays unreachable
//    E1  INIT + PLAIN TURN — system/init first, stream chrome swallowed,
//        usage ledger from stream events, stop_reason from message_delta,
//        the success envelope
//    E2  PARTIAL PASSTHROUGH + ACK — includePartialMessages re-yields
//        stream events; replayUserMessages acks the prompt BEFORE the
//        first settled message's projection
//    E3  TURN COUNT — num_turns = 1 + count of yielded user messages
//    E4  EMPTY ASSISTANT — swallowed by the SDK projection, still stored
//    E5  STOP-REASON PRECEDENCE — latest non-null wins, synthetic or delta
//    E6  MAX-TURNS ATTACHMENT — error_max_turns, num_turns from the
//        attachment, the generator closed early
//    E7  STRUCTURED-OUTPUT + QUEUED-COMMAND attachments
//    E8  COMPACT BOUNDARY — SDK compact_boundary + the memory release
//    E9  API-ERROR — system api_error projects to api_retry (categorized)
//    E10 TOOL-USE SUMMARY + TOMBSTONE — summary projected; tombstone
//        DROPPED (the SDK stream cannot retract)
//    E11 ERROR-DURING-EXECUTION — ede_diagnostic head + the turn-scoped
//        error watermark
//    E12 END-TURN CARVE-OUT — no assistant content, stop_reason end_turn
//        ⇒ success with empty result
//    E13 PERMISSION DENIALS — recorded via the canUseTool wrap; the
//        Agent→Task SDK-compat rename; allow records nothing
//    E14 BUDGET PREEMPT — maxBudgetUsd fires after the FIRST yield of any
//        type, before any content
//    E15 STRUCTURED-OUTPUT RETRY CEILING — 5 synthetic-output calls ⇒
//        error_max_structured_output_retries on the user yield
//    E16 NO-QUERY LOCAL COMMAND — init still emitted, local stdout as a
//        synthetic SDK assistant, resultText, zero query() calls
//    E17 INTERRUPT — abort is engine-external; the projection is
//        abort-blind (interrupt() aborts the shared controller, yields
//        keep projecting)
//    E18 MULTI-TURN ENGINE — state persists across submitMessage calls;
//        one init per turn; setModel applies to the NEXT turn
//    P1  joinPromptValues — batching join laws
//    P2  canBatchWith — prompt-mode/workload/isMeta gates
//    P3  removeInterruptedMessage — the user+sentinel splice
//    P4  handleSetPermissionMode — autopilot refused, bypass gated,
//        success transition
//    P5  getCanUseToolFn — stdio routes to StructuredIO; no-tool channel
//        honors forceDecision
//    S1–S9  handleMessageFromStream — mode routing, delta accumulation,
//        silent tool-input assembly, stable order, identity no-ops,
//        signature exclusion, tombstone, thinking capture, atomic
//        text-clear-before-append; isDroppedLateStreamFrame table
//    S10 PROJECTION EQUIVALENCE — a REAL query() run (scripted deps
//        callModel, T8 rig) recorded once; every yield feeds the
//        interactive projection totally; settlements append in order
//    X1  CROSS-SURFACE REPLAY — the SAME recorded yields replayed through
//        QueryEngine: the SDK projection agrees on settlements + result
//
//  CHARACTERIZED build facts this suite pins (do not "fix" silently):
//    • QueryEngine turn counting is USER-MESSAGE counting (tool_result
//      user messages increment num_turns).
//    • error_max_turns takes num_turns from the ATTACHMENT's turnCount,
//      not the engine's own counter.
//    • The budget check runs after EVERY yielded message type, including
//      stream_request_start — a zero budget preempts before any content.
//    • Tombstones never reach the SDK stream — a streaming-fallback
//      retraction is invisible to SDK consumers (REPL-only recovery).
//    • normalizeMessage splits one multi-block assistant into one SDK
//      assistant message per content block.
//    • A no-query local command's result.num_turns is a MESSAGE COUNT
//      (messages.length - 1), not a turn count.
//
//  Run: ~/.bun/bin/bun run scripts/core-runtime/prove-runsurface-contract.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'bun:test'
import { z } from 'zod/v4'

// ── hermetic env (BEFORE any src import) ────────────────────────────────────
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'runsurface-laws-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'runsurface-daemon-'))
process.env.MERCURY_TEAMS_DIR = mkdtempSync(join(tmpdir(), 'runsurface-teams-'))
const ENGINE_CWD = mkdtempSync(join(tmpdir(), 'runsurface-cwd-'))
for (const k of [
  'MERCURY_SIMPLE',
  'MERCURY_EFFORT_LEVEL',
  'MERCURY_MAX_OUTPUT_TOKENS',
  'MERCURY_BLOCKING_LIMIT_OVERRIDE',
  'MERCURY_EAGER_FLUSH',
  'MAX_STRUCTURED_OUTPUT_RETRIES',
  'MERCURY_RELEVANT_RECALL',
  'HERMES_ULTRATHINK_MAX',
  'MERCURY_FORCE_READ_FILES',
  'CLAUDE_TEAM_NAME',
  'CLAUDE_AGENT_NAME',
  'DISABLE_COMPACT',
  'DISABLE_AUTO_COMPACT',
  'NODE_ENV',
]) {
  delete process.env[k]
}
// CI-portability: the headless surface validates
// auth ENV early (print.ts refuses to boot without a key/token env) — the
// operator's shell supplied one ambiently, CI has none. The query module is
// mocked below and every unmocked leg rides fixtures, so a proof key is
// honest here and nothing can reach a real wire.
process.env.ANTHROPIC_API_KEY = 'proof-key-runsurface'

// ── the query-module mock (BEFORE the QueryEngine import) ───────────────────
// Capture the real query() by function reference first — the module
// namespace binding is re-pointed by mock.module below.
const realQueryModule = await import('../../src/query.ts')
const realQuery = realQueryModule.query
const realQueryEvents = realQueryModule.queryEvents

type EngineQueryCall = {
  querySource: unknown
  maxTurns: unknown
  taskBudget: unknown
  mainLoopModel: unknown
  messages: unknown[]
}
type EngineStep =
  | { kind: 'yield'; value: unknown }
  | { kind: 'do'; fn: (params: Record<string, unknown>) => void | Promise<void> }
const ey = (value: unknown): EngineStep => ({ kind: 'yield', value })

let activeEngineScript: EngineStep[] | null = null
const engineQueryCalls: EngineQueryCall[] = []
let lastEngineParams: Record<string, unknown> | null = null
let scriptRanToEnd = false
let scriptFinallyRan = false

async function* dispatchQuery(
  params: Record<string, unknown>,
): AsyncGenerator<unknown, unknown> {
  if (activeEngineScript === null) {
    return yield* realQuery(params as never)
  }
  lastEngineParams = params
  engineQueryCalls.push({
    querySource: params.querySource,
    maxTurns: params.maxTurns,
    taskBudget: params.taskBudget,
    mainLoopModel: (
      (params.toolUseContext as Record<string, unknown>)?.options as
        | Record<string, unknown>
        | undefined
    )?.mainLoopModel,
    messages: [...(params.messages as unknown[])],
  })
  scriptRanToEnd = false
  scriptFinallyRan = false
  try {
    for (const s of activeEngineScript) {
      if (s.kind === 'yield') yield s.value
      else await s.fn(params)
    }
    scriptRanToEnd = true
  } finally {
    scriptFinallyRan = true
  }
  return { reason: 'completed' }
}

// the engine consumes queryEvents (the run-event stream). Scripted
// LEGACY yields ride `notice` events — legacyYieldsOf(notice) projects the
// carried message verbatim, so every fixture keeps meaning exactly what it
// asserted pre-cut. A scripted step that already carries a RunEvent `kind`
// passes through as a real event (E10 drives the retraction skip this way).
async function* dispatchQueryEvents(
  params: Record<string, unknown>,
): AsyncGenerator<unknown, unknown> {
  if (activeEngineScript === null) {
    return yield* realQueryEvents(params as never)
  }
  lastEngineParams = params
  engineQueryCalls.push({
    querySource: params.querySource,
    maxTurns: params.maxTurns,
    taskBudget: params.taskBudget,
    mainLoopModel: (
      (params.toolUseContext as Record<string, unknown>)?.options as
        | Record<string, unknown>
        | undefined
    )?.mainLoopModel,
    messages: [...(params.messages as unknown[])],
  })
  scriptRanToEnd = false
  scriptFinallyRan = false
  let seq = 0
  try {
    for (const s of activeEngineScript) {
      if (s.kind === 'yield') {
        const v = s.value as { kind?: unknown }
        if (typeof v?.kind === 'string') yield { ...(s.value as object), seq: ++seq }
        else yield { kind: 'notice', seq: ++seq, message: s.value }
      } else await s.fn(params)
    }
    scriptRanToEnd = true
  } finally {
    scriptFinallyRan = true
  }
  return { reason: 'completed' }
}

mock.module('../../src/query.ts', () => ({
  ...realQueryModule,
  query: dispatchQuery,
  queryEvents: dispatchQueryEvents,
}))

// ── src imports (AFTER the mock) ────────────────────────────────────────────
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { QueryEngine } = await import('../../src/QueryEngine.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createAssistantMessage, createUserMessage } = await import(
  '../../src/utils/messages.ts'
)
const { createAttachmentMessage } = await import(
  '../../src/utils/attachments/orchestrator.ts'
)
const { createCompactBoundaryMessage, createSystemAPIErrorMessage } =
  await import('../../src/utils/messages/systemMessages.ts')
const { createFileStateCacheWithSizeLimit } = await import(
  '../../src/utils/fileStateCache.ts'
)
const { SYNTHETIC_OUTPUT_TOOL_NAME } = await import(
  '../../src/tools/SyntheticOutputTool/SyntheticOutputTool.ts'
)
const { AGENT_TOOL_NAME } = await import('../../src/tools/AgentTool/constants.ts')
const { logError } = await import('../../src/utils/log.ts')
const { checkFeatureGate_CACHED_MAY_BE_STALE } = await import(
  '../../src/services/analytics/featureGates.ts'
)
const printMod = await import('../../src/cli/print.ts')
const resumeMod = await import('../../src/cli/headless/resume.ts')
const controlMod = await import('../../src/cli/headless/controlHandlers.ts')
const permChanMod = await import('../../src/cli/headless/permissionChannel.ts')
const streamingMod = await import('../../src/utils/messages/streaming.ts')
const qm = await import('../../src/utils/messageQueueManager.ts')

const MODEL = 'claude-opus-4-8'
const MODEL2 = 'claude-sonnet-5'

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
  console.log('\nTIMEOUT — runsurface contract exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

console.log('native-core T10-T12 — run-surface contract')

// ── shared helpers ──────────────────────────────────────────────────────────

type AnyMsg = Record<string, unknown> & { type?: string; subtype?: string }
const settle = (): Promise<void> => new Promise(r => setTimeout(r, 5))

// Streamed assistants settle with stop_reason NULL (claude.ts yields at
// content_block_stop; the real value arrives via message_delta). The factory
// default is 'stop_sequence' — the SYNTHETIC shape, pinned explicitly in E5.
// These helpers emulate the STREAMED shape.
const asstText = (text: string): AnyMsg => {
  const m = createAssistantMessage({ content: text }) as unknown as AnyMsg
  ;(m.message as Record<string, unknown>).stop_reason = null
  return m
}
function asstToolUse(id: string, name: string, input: Record<string, unknown>): AnyMsg {
  const m = createAssistantMessage({
    content: [{ type: 'tool_use', id, name, input }] as never,
  }) as unknown as AnyMsg
  ;(m.message as Record<string, unknown>).stop_reason = null
  return m
}
function userToolResult(toolUseId: string, content: string): AnyMsg {
  return createUserMessage({
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] as never,
  }) as unknown as AnyMsg
}
const streamEvent = (event: Record<string, unknown>, ttftMs?: number): AnyMsg => ({
  type: 'stream_event',
  event,
  ...(ttftMs !== undefined ? { ttftMs } : {}),
})
const msgStart = (usage: Record<string, unknown>, ttftMs?: number): AnyMsg =>
  streamEvent({ type: 'message_start', message: { usage } }, ttftMs)
const msgDelta = (
  usage: Record<string, unknown> | undefined,
  stopReason: string | null,
): AnyMsg =>
  streamEvent({ type: 'message_delta', usage, delta: { stop_reason: stopReason } })
const msgStop = (): AnyMsg => streamEvent({ type: 'message_stop' })
const usageOf = (input: number, output: number): Record<string, unknown> => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
})

const sdkTypes = (yields: AnyMsg[]): string[] =>
  yields.map(y => `${y.type}${y.subtype ? ':' + y.subtype : ''}`)
const sdkAssistantTexts = (yields: AnyMsg[]): string[] =>
  yields
    .filter(y => y.type === 'assistant')
    .flatMap(y => {
      const c = (y.message as { content?: unknown } | undefined)?.content
      if (typeof c === 'string') return [c]
      return ((c as AnyMsg[] | undefined) ?? [])
        .filter(b => b.type === 'text')
        .map(b => String(b.text))
    })
const lastResult = (yields: AnyMsg[]): AnyMsg | undefined =>
  yields.filter(y => y.type === 'result').at(-1)

type PermissionDecision = Record<string, unknown>
type EngineOpts = {
  prompt?: string
  steps?: EngineStep[]
  tools?: unknown[]
  canUseTool?: (...args: unknown[]) => Promise<PermissionDecision>
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: { total: number }
  jsonSchema?: Record<string, unknown>
  replayUserMessages?: boolean
  includePartialMessages?: boolean
  abortController?: AbortController
  engine?: InstanceType<typeof QueryEngine>
}

const allowAll = async (
  _tool: unknown,
  input: unknown,
): Promise<PermissionDecision> => ({
  behavior: 'allow',
  updatedInput: input as Record<string, unknown>,
  decisionReason: { type: 'other', reason: 'rig' },
})

const rigLocalCommand = {
  type: 'local',
  name: 'rigcmd',
  description: 'rig local command',
  userInvocable: true,
  supportsNonInteractive: true,
  load: async () => ({
    call: async (args: string) => ({ type: 'text', value: `local says ${args}` }),
  }),
}

function makeEngine(opts: EngineOpts): InstanceType<typeof QueryEngine> {
  let appState: Record<string, unknown> = {
    ...(getDefaultAppState() as unknown as Record<string, unknown>),
    effortValue: 'high',
  }
  return new QueryEngine({
    cwd: ENGINE_CWD,
    tools: (opts.tools ?? []) as never,
    commands: [rigLocalCommand] as never,
    mcpClients: [],
    agents: [],
    canUseTool: (opts.canUseTool ?? allowAll) as never,
    getAppState: () => appState as never,
    setAppState: f => {
      appState = f(appState as never) as unknown as Record<string, unknown>
    },
    readFileCache: createFileStateCacheWithSizeLimit(100),
    userSpecifiedModel: MODEL,
    maxTurns: opts.maxTurns,
    maxBudgetUsd: opts.maxBudgetUsd,
    taskBudget: opts.taskBudget,
    jsonSchema: opts.jsonSchema,
    replayUserMessages: opts.replayUserMessages,
    includePartialMessages: opts.includePartialMessages,
    abortController: opts.abortController,
  })
}

type EngineRun = {
  yields: AnyMsg[]
  calls: EngineQueryCall[]
  engine: InstanceType<typeof QueryEngine>
}
async function runEngine(opts: EngineOpts): Promise<EngineRun> {
  const engine = opts.engine ?? makeEngine(opts)
  activeEngineScript = opts.steps ?? []
  engineQueryCalls.length = 0
  const yields: AnyMsg[] = []
  try {
    for await (const m of engine.submitMessage(opts.prompt ?? 'engine rig prompt')) {
      yields.push(m as AnyMsg)
    }
  } finally {
    activeEngineScript = null
  }
  await settle()
  return { yields, calls: [...engineQueryCalls], engine }
}

// ── R1 T9 REACHABILITY PIN ──────────────────────────────────────────────────
section('R1 T9 PIN — the streaming-tool-execution gate is permanently FALSE')
{
  check(
    'mercury_streaming_tool_execution2 is false (FORK_GATE_TABLE empty) — StreamingToolExecutor unreachable',
    checkFeatureGate_CACHED_MAY_BE_STALE('mercury_streaming_tool_execution2') ===
      false,
  )
}

// ── E1 INIT + PLAIN TURN ────────────────────────────────────────────────────
section('E1 INIT + PLAIN TURN — init first, chrome swallowed, envelope synthesized')
{
  const r = await runEngine({
    steps: [
      ey({ type: 'stream_request_start' }),
      ey(msgStart(usageOf(100, 1))),
      ey(asstText('the answer.')),
      ey(msgDelta(usageOf(0, 42), 'end_turn')),
      ey(msgStop()),
    ],
  })
  const types = sdkTypes(r.yields)
  check('first SDK message is system:init', types[0] === 'system:init', types.join(','))
  const init = r.yields[0]!
  check('init carries the model', init.model === MODEL, String(init.model))
  check(
    'init cwd is the engine cwd (realpath — setCwd resolves /var→/private/var)',
    init.cwd === realpathSync(ENGINE_CWD),
    String(init.cwd),
  )
  check(
    'init slash_commands lists the rig local command',
    Array.isArray(init.slash_commands) &&
      (init.slash_commands as string[]).includes('rigcmd'),
  )
  check(
    'init mercury_version is the MACRO stamp (the Mercury stream dialect)',
    init.mercury_version === '1.0.0',
    String(init.mercury_version),
  )
  check('stream_request_start never reaches the SDK stream', !types.includes('stream_request_start'))
  check(
    'stream_event not yielded without includePartialMessages',
    !types.includes('stream_event'),
  )
  check(
    'exactly one SDK assistant with the text',
    JSON.stringify(sdkAssistantTexts(r.yields)) === JSON.stringify(['the answer.']),
    JSON.stringify(sdkAssistantTexts(r.yields)),
  )
  const res = lastResult(r.yields)!
  check('result subtype success', res.subtype === 'success', JSON.stringify(res.subtype))
  check('result is_error false', res.is_error === false)
  check('result num_turns 1 (no user yields)', res.num_turns === 1, String(res.num_turns))
  check(
    "result stop_reason 'end_turn' (captured from message_delta)",
    res.stop_reason === 'end_turn',
    String(res.stop_reason),
  )
  check('result text is the last text block', res.result === 'the answer.', String(res.result))
  const usage = res.usage as Record<string, number>
  check(
    'usage ledger: input from message_start, output from message_delta, settled at message_stop',
    usage.input_tokens === 100 && usage.output_tokens === 42,
    JSON.stringify({ i: usage.input_tokens, o: usage.output_tokens }),
  )
  check('permission_denials empty', JSON.stringify(res.permission_denials) === '[]')
  check('one query() call', r.calls.length === 1, String(r.calls.length))
  check("query called with querySource 'sdk'", r.calls[0]!.querySource === 'sdk')
  check(
    'query rode the engine model',
    r.calls[0]!.mainLoopModel === MODEL,
    String(r.calls[0]!.mainLoopModel),
  )
  check(
    "the engine store gained the prompt + assistant",
    r.engine.getMessages().some(m => (m as AnyMsg).type === 'assistant'),
  )
  check('the fake generator ran to completion', scriptRanToEnd)
}

// ── E2 PARTIAL PASSTHROUGH + ACK ────────────────────────────────────────────
section('E2 PARTIALS + ACK — stream passthrough; the prompt ack precedes the projection')
{
  const r = await runEngine({
    includePartialMessages: true,
    replayUserMessages: true,
    steps: [
      ey(msgStart(usageOf(10, 1))),
      ey(asstText('partial-mode answer')),
      ey(msgStop()),
    ],
  })
  const types = sdkTypes(r.yields)
  const streamYields = r.yields.filter(y => y.type === 'stream_event')
  check('stream events pass through with includePartialMessages', streamYields.length === 2, String(streamYields.length))
  check(
    'passthrough carries session_id + uuid',
    streamYields.every(y => typeof y.session_id === 'string' && typeof y.uuid === 'string'),
  )
  check(
    'passthrough preserves the raw event payload',
    (streamYields[0]!.event as AnyMsg).type === 'message_start',
  )
  const ackIdx = r.yields.findIndex(y => y.type === 'user' && y.isReplay === true)
  const asstIdx = r.yields.findIndex(y => y.type === 'assistant')
  check('the prompt is acked as an isReplay user message', ackIdx !== -1, types.join(','))
  check(
    'the ack precedes the assistant projection (recorded-then-acked order)',
    ackIdx !== -1 && asstIdx !== -1 && ackIdx < asstIdx,
    `ack@${ackIdx} asst@${asstIdx}`,
  )
  check(
    'the acked message carries the submitted prompt',
    JSON.stringify((r.yields[ackIdx]!.message as AnyMsg)?.content).includes(
      'engine rig prompt',
    ),
  )
}

// ── E3 TURN COUNT ───────────────────────────────────────────────────────────
section('E3 TURN COUNT — num_turns = 1 + yielded user messages (tool_results count)')
{
  const r = await runEngine({
    steps: [
      ey(asstToolUse('tu_e3', 'EchoTool', { text: 'x' })),
      ey(userToolResult('tu_e3', 'echo:x')),
      ey(asstText('after tools')),
      ey(msgDelta(undefined, 'end_turn')),
    ],
  })
  const res = lastResult(r.yields)!
  check('result success', res.subtype === 'success', String(res.subtype))
  check(
    'num_turns 2 — the tool_result user message incremented the count (CHARACTERIZED: user-message counting)',
    res.num_turns === 2,
    String(res.num_turns),
  )
  const userYields = r.yields.filter(y => y.type === 'user' && y.isReplay !== true)
  check('the tool_result user message projects to the SDK stream', userYields.length === 1, String(userYields.length))
  check(
    'the SDK user yield carries the tool_result block',
    JSON.stringify(userYields[0]!.message).includes('tu_e3'),
  )

  // One multi-block assistant → one SDK assistant PER content block
  // (normalizeMessage rides normalizeMessages' block splitting).
  const multi = createAssistantMessage({
    content: [
      { type: 'text', text: 'block one' },
      { type: 'text', text: 'block two' },
    ] as never,
  }) as unknown as AnyMsg
  ;(multi.message as Record<string, unknown>).stop_reason = null
  const r2 = await runEngine({
    steps: [ey(multi), ey(msgDelta(undefined, 'end_turn'))],
  })
  check(
    'CHARACTERIZED: a multi-block assistant splits into one SDK assistant per block',
    JSON.stringify(sdkAssistantTexts(r2.yields)) ===
      JSON.stringify(['block one', 'block two']) &&
      r2.yields.filter(y => y.type === 'assistant').length === 2,
    JSON.stringify(sdkAssistantTexts(r2.yields)),
  )
}

// ── E4 EMPTY ASSISTANT ──────────────────────────────────────────────────────
section('E4 EMPTY ASSISTANT — swallowed by the projection, still stored')
{
  const before = makeEngine({})
  const r = await runEngine({
    engine: before,
    steps: [ey(asstText('')), ey(msgDelta(undefined, 'end_turn'))],
  })
  check(
    'zero SDK assistant yields for an empty assistant (isNotEmptyMessage filter)',
    r.yields.filter(y => y.type === 'assistant').length === 0,
    sdkTypes(r.yields).join(','),
  )
  check(
    'the empty assistant still landed in the engine store (CHARACTERIZED asymmetry)',
    r.engine.getMessages().some(m => (m as AnyMsg).type === 'assistant'),
  )
  const res = lastResult(r.yields)!
  check(
    'result is still success (the empty assistant last-content is text)',
    res.subtype === 'success',
    String(res.subtype),
  )
  check(
    "CHARACTERIZED: the '(no content)' placeholder LEAKS into result.result — the SDK " +
      'stream swallows the empty assistant (isNotEmptyMessage) but the result extraction ' +
      'does not filter it (NO_CONTENT_MESSAGE is not in SYNTHETIC_MESSAGES)',
    res.result === '(no content)',
    JSON.stringify(res.result),
  )
}

// ── E5 STOP-REASON PRECEDENCE ───────────────────────────────────────────────
section('E5 STOP-REASON — latest non-null wins across synthetic + delta sources')
{
  const stamped = asstText('stamped')
  ;(stamped.message as Record<string, unknown>).stop_reason = 'tool_use'
  const r = await runEngine({
    steps: [ey(stamped), ey(msgDelta(undefined, 'end_turn'))],
  })
  check(
    'delta after synthetic: end_turn wins',
    lastResult(r.yields)!.stop_reason === 'end_turn',
    String(lastResult(r.yields)!.stop_reason),
  )

  // The FACTORY default ('stop_sequence' — the synthetic shape): an explicit
  // non-null synthetic stop_reason yielded AFTER a delta capture wins.
  const stamped2 = asstText('stamped2')
  ;(stamped2.message as Record<string, unknown>).stop_reason = 'stop_sequence'
  const r2 = await runEngine({
    steps: [ey(msgDelta(undefined, 'end_turn')), ey(stamped2)],
  })
  check(
    'synthetic after delta: the synthetic stop_reason wins (yield order, not source)',
    lastResult(r2.yields)!.stop_reason === 'stop_sequence',
    String(lastResult(r2.yields)!.stop_reason),
  )
  const r3 = await runEngine({
    steps: [ey(msgDelta(undefined, 'end_turn')), ey(asstText('null-shaped'))],
  })
  check(
    'a null (streamed-shape) assistant never clobbers the captured stop_reason',
    lastResult(r3.yields)!.stop_reason === 'end_turn',
    String(lastResult(r3.yields)!.stop_reason),
  )
}

// ── E6 MAX-TURNS ATTACHMENT ─────────────────────────────────────────────────
section('E6 MAX-TURNS — error_max_turns from the attachment, generator closed early')
{
  const r = await runEngine({
    maxTurns: 3,
    steps: [
      ey(asstText('some work')),
      ey(
        createAttachmentMessage({
          type: 'max_turns_reached',
          maxTurns: 3,
          turnCount: 7,
        } as never),
      ),
      ey(asstText('NEVER PROJECTED')),
    ],
  })
  const res = lastResult(r.yields)!
  check('result subtype error_max_turns', res.subtype === 'error_max_turns', String(res.subtype))
  check('result is_error true', res.is_error === true)
  check(
    "num_turns comes from the ATTACHMENT's turnCount (CHARACTERIZED), not the engine counter",
    res.num_turns === 7,
    String(res.num_turns),
  )
  check(
    'errors[] names the cap',
    Array.isArray(res.errors) && String(res.errors[0]).includes('maximum number of turns (3)'),
    JSON.stringify(res.errors),
  )
  check(
    'the post-attachment assistant never projects',
    !sdkAssistantTexts(r.yields).includes('NEVER PROJECTED'),
  )
  check('the generator was closed early (finally ran, steps did not complete)', scriptFinallyRan && !scriptRanToEnd)
  check('maxTurns was passed through to query()', r.calls[0]!.maxTurns === 3)
}

// ── E7 STRUCTURED-OUTPUT + QUEUED-COMMAND attachments ───────────────────────
section('E7 ATTACHMENTS — structured_output capture; queued_command replay gating')
{
  const r = await runEngine({
    steps: [
      ey(createAttachmentMessage({ type: 'structured_output', data: { answer: 42 } } as never)),
      ey(asstText('done')),
      ey(msgDelta(undefined, 'end_turn')),
    ],
  })
  const res = lastResult(r.yields)!
  check(
    'structured_output attachment lands on the success result',
    JSON.stringify(res.structured_output) === JSON.stringify({ answer: 42 }),
    JSON.stringify(res.structured_output),
  )

  const srcUuid = '99999999-9999-4999-8999-999999999999'
  const queued = createAttachmentMessage({
    type: 'queued_command',
    prompt: 'queued follow-up',
    source_uuid: srcUuid,
  } as never)
  const r2 = await runEngine({
    replayUserMessages: true,
    steps: [ey(queued), ey(asstText('after drain')), ey(msgDelta(undefined, 'end_turn'))],
  })
  const replay = r2.yields.find(
    y =>
      y.type === 'user' &&
      y.isReplay === true &&
      JSON.stringify(y.message).includes('queued follow-up'),
  )
  check('queued_command replays as an SDK user message (replayUserMessages on)', replay !== undefined)
  check('the replay uuid is the source_uuid', replay?.uuid === srcUuid, String(replay?.uuid))

  const r3 = await runEngine({
    steps: [ey(queued), ey(asstText('after drain')), ey(msgDelta(undefined, 'end_turn'))],
  })
  check(
    'without replayUserMessages the queued_command never yields',
    !r3.yields.some(y => JSON.stringify(y.message ?? '').includes('queued follow-up')),
  )
}

// ── E8 COMPACT BOUNDARY ─────────────────────────────────────────────────────
section('E8 COMPACT BOUNDARY — SDK compact_boundary + the memory release')
{
  const boundary = createCompactBoundaryMessage('auto', 900)
  const r = await runEngine({
    steps: [
      ey(asstText('pre-compact')),
      ey(boundary),
      ey(asstText('post-compact')),
      ey(msgDelta(undefined, 'end_turn')),
    ],
  })
  const sdkBoundary = r.yields.find(
    y => y.type === 'system' && y.subtype === 'compact_boundary',
  )
  check('SDK compact_boundary yielded', sdkBoundary !== undefined, sdkTypes(r.yields).join(','))
  check(
    'compact_metadata projected {trigger, pre_tokens}',
    JSON.stringify(sdkBoundary?.compact_metadata) ===
      JSON.stringify({ trigger: 'auto', pre_tokens: 900 }),
    JSON.stringify(sdkBoundary?.compact_metadata),
  )
  const stored = r.engine.getMessages()
  check(
    'the engine store was RELEASED to the boundary (first stored message IS the boundary)',
    (stored[0] as AnyMsg)?.subtype === 'compact_boundary',
    String((stored[0] as AnyMsg)?.type) + ':' + String((stored[0] as AnyMsg)?.subtype),
  )
  check(
    'post-compact messages survive the release',
    stored.some(
      m =>
        (m as AnyMsg).type === 'assistant' &&
        JSON.stringify((m as AnyMsg).message).includes('post-compact'),
    ),
  )
}

// ── E9 API-ERROR → api_retry ────────────────────────────────────────────────
section('E9 API-ERROR — system api_error projects to api_retry, categorized')
{
  const apiErr = createSystemAPIErrorMessage(
    { status: 529, message: 'overloaded' } as never,
    1200,
    1,
    10,
  )
  const r = await runEngine({
    steps: [ey(apiErr), ey(asstText('recovered')), ey(msgDelta(undefined, 'end_turn'))],
  })
  const retry = r.yields.find(y => y.type === 'system' && y.subtype === 'api_retry')
  check('api_retry yielded', retry !== undefined, sdkTypes(r.yields).join(','))
  check('attempt/max/delay projected', retry?.attempt === 1 && retry?.max_retries === 10 && retry?.retry_delay_ms === 1200, JSON.stringify(retry))
  check('error_status projected', retry?.error_status === 529, String(retry?.error_status))
  check(
    "a 529 categorizes as 'rate_limit'",
    retry?.error === 'rate_limit',
    String(retry?.error),
  )
}

// ── E10 TOOL-USE SUMMARY + TOMBSTONE ────────────────────────────────────────
section('E10 SUMMARY + TOMBSTONE — summary projected; tombstone dropped')
{
  const orphan = asstText('to be tombstoned')
  const r = await runEngine({
    steps: [
      ey(orphan),
      // the retraction now arrives as its event (assistant_retracted),
      // not a legacy tombstone message — the engine skips it by kind.
      ey({ kind: 'assistant_retracted', message: orphan }),
      ey({
        type: 'tool_use_summary',
        summary: 'did the things',
        precedingToolUseIds: ['tu_s'],
        uuid: 'rig-sum',
      }),
      ey(asstText('final')),
      ey(msgDelta(undefined, 'end_turn')),
    ],
  })
  const summary = r.yields.find(y => y.type === 'tool_use_summary')
  check('tool_use_summary projects to the SDK stream', summary !== undefined)
  check(
    'summary fields renamed to snake_case',
    summary?.summary === 'did the things' &&
      JSON.stringify(summary?.preceding_tool_use_ids) === JSON.stringify(['tu_s']),
    JSON.stringify(summary),
  )
  check(
    'the tombstone NEVER reaches the SDK stream (CHARACTERIZED: no retraction)',
    !r.yields.some(y => y.type === 'tombstone'),
  )
  check(
    'the tombstoned assistant stays yielded (retraction is invisible to SDK consumers)',
    sdkAssistantTexts(r.yields).includes('to be tombstoned'),
  )
}

// ── E11 ERROR-DURING-EXECUTION ──────────────────────────────────────────────
section('E11 EDE — diagnostic head + the turn-scoped error watermark')
{
  logError(new Error('PRE-TURN error — must be excluded'))
  const r = await runEngine({
    steps: [
      { kind: 'do', fn: () => logError(new Error('IN-TURN rig error')) },
      ey(asstToolUse('tu_ede', 'EchoTool', { text: 'x' })),
    ],
  })
  const res = lastResult(r.yields)!
  check('result subtype error_during_execution', res.subtype === 'error_during_execution', String(res.subtype))
  check('is_error true', res.is_error === true)
  const errors = (res.errors ?? []) as string[]
  check(
    'errors[0] is the ede_diagnostic (result_type=assistant last_content_type=tool_use stop_reason=null)',
    errors[0] ===
      '[ede_diagnostic] result_type=assistant last_content_type=tool_use stop_reason=null',
    JSON.stringify(errors[0]),
  )
  check(
    'the in-turn error is included (watermark scope)',
    errors.some(e => e.includes('IN-TURN rig error')),
    JSON.stringify(errors),
  )
  check(
    'the pre-turn error is EXCLUDED (watermark scope)',
    !errors.some(e => e.includes('PRE-TURN error')),
    JSON.stringify(errors),
  )
}

// ── E12 END-TURN CARVE-OUT ──────────────────────────────────────────────────
section('E12 END-TURN CARVE-OUT — zero assistant content, end_turn ⇒ empty success')
{
  const r = await runEngine({
    steps: [ey(msgDelta(undefined, 'end_turn'))],
  })
  const res = lastResult(r.yields)!
  check(
    'result success on a content-free end_turn turn (the carve-out)',
    res.subtype === 'success',
    String(res.subtype),
  )
  check("result text ''", res.result === '', JSON.stringify(res.result))
  check("stop_reason 'end_turn'", res.stop_reason === 'end_turn')
  check('num_turns 1', res.num_turns === 1, String(res.num_turns))
}

// ── E13 PERMISSION DENIALS ──────────────────────────────────────────────────
section('E13 DENIALS — recorded via the wrap; Agent→Task rename; allow silent')
{
  const denyAll = async (): Promise<PermissionDecision> => ({
    behavior: 'deny',
    message: 'rig denies',
    decisionReason: { type: 'other', reason: 'rig' },
  })
  const agentishTool = { name: AGENT_TOOL_NAME }
  const plainTool = { name: 'EchoTool' }
  const r = await runEngine({
    canUseTool: denyAll,
    steps: [
      {
        kind: 'do',
        fn: async params => {
          const wrapped = params.canUseTool as (
            ...a: unknown[]
          ) => Promise<PermissionDecision>
          await wrapped(agentishTool, { x: 1 }, params.toolUseContext, asstText('a'), 'tu_perm1', undefined)
          await wrapped(plainTool, { y: 2 }, params.toolUseContext, asstText('a'), 'tu_perm2', undefined)
        },
      },
      ey(asstText('after denials')),
      ey(msgDelta(undefined, 'end_turn')),
    ],
  })
  const denials = (lastResult(r.yields)!.permission_denials ?? []) as AnyMsg[]
  check('two denials recorded', denials.length === 2, JSON.stringify(denials))
  check(
    "the Agent tool reports under its own name (the compat rename retired)",
    denials[0]?.tool_name === 'Agent',
    String(denials[0]?.tool_name),
  )
  check(
    'denial carries tool_use_id + tool_input',
    denials[0]?.tool_use_id === 'tu_perm1' &&
      JSON.stringify(denials[0]?.tool_input) === JSON.stringify({ x: 1 }),
    JSON.stringify(denials[0]),
  )

  const r2 = await runEngine({
    canUseTool: allowAll,
    steps: [
      {
        kind: 'do',
        fn: async params => {
          const wrapped = params.canUseTool as (
            ...a: unknown[]
          ) => Promise<PermissionDecision>
          await wrapped(plainTool, { y: 2 }, params.toolUseContext, asstText('a'), 'tu_perm3', undefined)
        },
      },
      ey(asstText('after allow')),
      ey(msgDelta(undefined, 'end_turn')),
    ],
  })
  check(
    'an allow decision records NO denial',
    ((lastResult(r2.yields)!.permission_denials ?? []) as unknown[]).length === 0,
  )
}

// ── E14 BUDGET PREEMPT ──────────────────────────────────────────────────────
section('E14 BUDGET — a zero budget preempts after the FIRST yield, before content')
{
  const r = await runEngine({
    maxBudgetUsd: 0,
    steps: [
      ey({ type: 'stream_request_start' }),
      ey(asstText('NEVER PROJECTED — budget preempts first')),
    ],
  })
  const res = lastResult(r.yields)!
  check('result subtype error_max_budget_usd', res.subtype === 'error_max_budget_usd', String(res.subtype))
  check('is_error true', res.is_error === true)
  check(
    'errors[] names the budget',
    Array.isArray(res.errors) && String(res.errors[0]).includes('maximum budget ($0)'),
    JSON.stringify(res.errors),
  )
  check(
    'CHARACTERIZED: the check runs after EVERY message type — zero assistant yields',
    r.yields.filter(y => y.type === 'assistant').length === 0,
    sdkTypes(r.yields).join(','),
  )
  check('the generator was closed early', scriptFinallyRan && !scriptRanToEnd)
}

// ── E15 STRUCTURED-OUTPUT RETRY CEILING ─────────────────────────────────────
section('E15 SO RETRY CEILING — 5 synthetic-output calls ⇒ typed error on the user yield')
{
  const steps: EngineStep[] = []
  for (let i = 1; i <= 5; i++) {
    steps.push(ey(asstToolUse(`tu_so_${i}`, SYNTHETIC_OUTPUT_TOOL_NAME, { v: i })))
    steps.push(ey(userToolResult(`tu_so_${i}`, 'retry')))
  }
  steps.push(ey(asstText('NEVER REACHED')))
  const r = await runEngine({ jsonSchema: { type: 'object' }, steps })
  const res = lastResult(r.yields)!
  check(
    'result subtype error_max_structured_output_retries',
    res.subtype === 'error_max_structured_output_retries',
    String(res.subtype),
  )
  check(
    'errors[] names the retry ceiling (default 5)',
    Array.isArray(res.errors) && String(res.errors[0]).includes('after 5 attempts'),
    JSON.stringify(res.errors),
  )
  check('num_turns 6 (1 + five user yields)', res.num_turns === 6, String(res.num_turns))
  check(
    'the post-ceiling assistant never projects',
    !sdkAssistantTexts(r.yields).includes('NEVER REACHED'),
  )
  check(
    'fewer calls do NOT trip the ceiling',
    await (async () => {
      const okSteps: EngineStep[] = []
      for (let i = 1; i <= 4; i++) {
        okSteps.push(ey(asstToolUse(`tu_ok_${i}`, SYNTHETIC_OUTPUT_TOOL_NAME, { v: i })))
        okSteps.push(ey(userToolResult(`tu_ok_${i}`, 'retry')))
      }
      okSteps.push(ey(asstText('made it')))
      okSteps.push(ey(msgDelta(undefined, 'end_turn')))
      const r2 = await runEngine({ jsonSchema: { type: 'object' }, steps: okSteps })
      return lastResult(r2.yields)!.subtype === 'success'
    })(),
  )
}

// ── E16 NO-QUERY LOCAL COMMAND ──────────────────────────────────────────────
section('E16 NO-QUERY — local command: init + synthetic assistant + resultText, zero query calls')
{
  const r = await runEngine({ prompt: '/rigcmd hello', steps: [] })
  check('zero query() calls on the no-query path', r.calls.length === 0, String(r.calls.length))
  check('system:init still yielded', sdkTypes(r.yields)[0] === 'system:init')
  const asst = r.yields.find(y => y.type === 'assistant')
  const asstText0 = (
    (asst?.message as { content?: Array<{ text?: string }> } | undefined)?.content ?? []
  )[0]?.text
  check(
    'local stdout projects as a synthetic SDK assistant — TAGS STRIPPED, model <synthetic>',
    asst !== undefined &&
      asstText0 === 'local says hello' &&
      (asst.message as AnyMsg).model === '<synthetic>',
    JSON.stringify(asst?.message ?? null),
  )
  const res = lastResult(r.yields)!
  check('result success', res.subtype === 'success')
  check(
    'result text is the local resultText',
    res.result === 'local says hello',
    JSON.stringify(res.result),
  )
  check(
    'CHARACTERIZED: no-query num_turns is a MESSAGE COUNT (store length - 1), not turns',
    res.num_turns === r.engine.getMessages().length - 1,
    `num_turns=${String(res.num_turns)} store=${r.engine.getMessages().length}`,
  )
  check("stop_reason null on the no-query result", res.stop_reason === null)
}

// ── E17 INTERRUPT — abort is engine-external ────────────────────────────────
section('E17 INTERRUPT — interrupt() aborts the shared controller; projection is abort-blind')
{
  const controller = new AbortController()
  let observedAborted: boolean | null = null
  let engineRef: InstanceType<typeof QueryEngine> | null = null
  const engine = makeEngine({ abortController: controller })
  engineRef = engine
  const r = await runEngine({
    engine,
    abortController: controller,
    steps: [
      ey(asstText('before interrupt')),
      {
        kind: 'do',
        fn: params => {
          engineRef!.interrupt()
          observedAborted = (
            (params.toolUseContext as Record<string, unknown>)
              .abortController as AbortController
          ).signal.aborted
        },
      },
      ey(asstText('after interrupt — still projected')),
      ey(msgDelta(undefined, 'end_turn')),
    ],
  })
  check('interrupt() aborts the controller threaded into toolUseContext', observedAborted === true)
  check(
    'CHARACTERIZED: the projection is abort-blind — post-abort yields still project',
    sdkAssistantTexts(r.yields).includes('after interrupt — still projected'),
  )
  check(
    'the run still synthesizes its result (abort semantics live in query(), not the engine)',
    lastResult(r.yields) !== undefined,
  )
}

// ── E18 MULTI-TURN ENGINE ───────────────────────────────────────────────────
section('E18 MULTI-TURN — state persists across submitMessage; setModel applies next turn')
{
  const engine = makeEngine({})
  const r1 = await runEngine({
    engine,
    prompt: 'first turn prompt',
    steps: [ey(asstText('turn one answer')), ey(msgDelta(undefined, 'end_turn'))],
  })
  check('turn 1 success', lastResult(r1.yields)!.subtype === 'success')
  engine.setModel(MODEL2)
  const r2 = await runEngine({
    engine,
    prompt: 'second turn prompt',
    steps: [ey(asstText('turn two answer')), ey(msgDelta(undefined, 'end_turn'))],
  })
  check('turn 2 init yielded (one init PER submitMessage)', sdkTypes(r2.yields)[0] === 'system:init')
  check(
    'setModel applies to the next turn',
    r2.yields[0]!.model === MODEL2 && r2.calls[0]!.mainLoopModel === MODEL2,
    `init=${String(r2.yields[0]!.model)} query=${String(r2.calls[0]!.mainLoopModel)}`,
  )
  const turn2Input = r2.calls[0]!.messages
  check(
    "turn 2's query input carries turn 1's conversation (engine state persists)",
    JSON.stringify(turn2Input).includes('turn one answer') &&
      JSON.stringify(turn2Input).includes('first turn prompt'),
  )
  check(
    'the engine store holds both turns',
    JSON.stringify(engine.getMessages()).includes('turn two answer'),
  )
}

// ── P1 joinPromptValues ─────────────────────────────────────────────────────
section('P1 joinPromptValues — batching join laws')
{
  const { joinPromptValues } = printMod
  const single = [{ type: 'text', text: 'only' }]
  check(
    'single value passes through by reference',
    joinPromptValues([single as never]) === single,
  )
  check(
    'all-string values newline-join',
    joinPromptValues(['a', 'b', 'c'] as never) === 'a\nb\nc',
  )
  const mixed = joinPromptValues([
    'lead text',
    [{ type: 'text', text: 'block' }] as never,
  ])
  check(
    'mixed values normalize to one block array (string wrapped as text block)',
    Array.isArray(mixed) &&
      mixed.length === 2 &&
      (mixed[0] as AnyMsg).text === 'lead text' &&
      (mixed[1] as AnyMsg).text === 'block',
    JSON.stringify(mixed),
  )
}

// ── P2 canBatchWith ─────────────────────────────────────────────────────────
section('P2 canBatchWith — prompt-mode/workload/isMeta gates')
{
  const { canBatchWith } = printMod
  const head = { mode: 'prompt', workload: 'w1', isMeta: false } as never
  const mk = (o: Record<string, unknown>): never => o as never
  check('same mode+workload+isMeta batches', canBatchWith(head, mk({ mode: 'prompt', workload: 'w1', isMeta: false })))
  check('undefined next never batches', !canBatchWith(head, undefined))
  check(
    'non-prompt mode never batches',
    !canBatchWith(head, mk({ mode: 'task-notification', workload: 'w1', isMeta: false })),
  )
  check(
    'workload mismatch never batches',
    !canBatchWith(head, mk({ mode: 'prompt', workload: 'w2', isMeta: false })),
  )
  check(
    'isMeta mismatch never batches (proactive ticks stay unmerged)',
    !canBatchWith(head, mk({ mode: 'prompt', workload: 'w1', isMeta: true })),
  )
}

// ── P3 removeInterruptedMessage ─────────────────────────────────────────────
section('P3 removeInterruptedMessage — the user+sentinel splice')
{
  const { removeInterruptedMessage } = resumeMod
  const u = (uuid: string): AnyMsg => ({ type: 'user', uuid })
  const a = (uuid: string): AnyMsg => ({ type: 'assistant', uuid })
  const msgs = [u('u1'), a('a1'), u('u2'), a('sentinel'), a('a2')]
  removeInterruptedMessage(msgs as never, { uuid: 'u2' } as never)
  check(
    'removes the user message AND the immediately-following sentinel (2 entries)',
    JSON.stringify(msgs.map(m => m.uuid)) === JSON.stringify(['u1', 'a1', 'a2']),
    JSON.stringify(msgs.map(m => m.uuid)),
  )
  const msgs2 = [u('u1'), a('a1')]
  removeInterruptedMessage(msgs2 as never, { uuid: 'missing' } as never)
  check('missing uuid leaves the array untouched', msgs2.length === 2)
  const msgs3 = [u('u1'), u('last')]
  removeInterruptedMessage(msgs3 as never, { uuid: 'last' } as never)
  check(
    'a tail-position match splices safely (no sentinel present)',
    JSON.stringify(msgs3.map(m => m.uuid)) === JSON.stringify(['u1']),
  )
}

// ── P4 handleSetPermissionMode ──────────────────────────────────────────────
section('P4 handleSetPermissionMode — autopilot refused, bypass gated, success transition')
{
  const { handleSetPermissionMode } = controlMod
  const responses: AnyMsg[] = []
  const output = { enqueue: (m: unknown) => responses.push(m as AnyMsg) }
  const baseCtx = {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    isBypassPermissionsModeAvailable: false,
  }

  const afterAutopilot = handleSetPermissionMode(
    { mode: 'autopilot' } as never,
    'req-1',
    baseCtx as never,
    output as never,
  )
  const resp1 = (responses.at(-1)?.response ?? {}) as AnyMsg
  check(
    'autopilot is refused in SDK/print mode (error response)',
    resp1.subtype === 'error' && String(resp1.error).includes('autopilot'),
    JSON.stringify(resp1),
  )
  check('the refused context is returned unchanged (same reference)', afterAutopilot === (baseCtx as never))

  handleSetPermissionMode(
    { mode: 'sovereign' } as never,
    'req-2',
    baseCtx as never,
    output as never,
  )
  const resp2 = (responses.at(-1)?.response ?? {}) as AnyMsg
  check(
    'sovereign is refused without the launch-time eligibility',
    resp2.subtype === 'error' &&
      String(resp2.error).includes('--dangerously-skip-permissions'),
    JSON.stringify(resp2),
  )

  const afterPlan = handleSetPermissionMode(
    { mode: 'strategy' } as never,
    'req-3',
    baseCtx as never,
    output as never,
  ) as unknown as AnyMsg
  const resp3 = (responses.at(-1)?.response ?? {}) as AnyMsg
  check(
    'a plain mode switch succeeds (success response carries the mode)',
    resp3.subtype === 'success' &&
      JSON.stringify(resp3.response) === JSON.stringify({ mode: 'strategy' }),
    JSON.stringify(resp3),
  )
  check("the returned context carries mode 'strategy'", afterPlan.mode === 'strategy')
}

// ── P5 getCanUseToolFn — channel resolution ─────────────────────────────────
section('P5 getCanUseToolFn — stdio routes to StructuredIO; forceDecision passthrough')
{
  const { getCanUseToolFn } = permChanMod
  const marker = async (): Promise<PermissionDecision> => ({ behavior: 'allow' })
  let createCalls = 0
  const fakeIO = {
    createCanUseTool: () => {
      createCalls++
      return marker
    },
  }
  const viaStdio = getCanUseToolFn('stdio', fakeIO as never, () => [])
  check("'stdio' routes to structuredIO.createCanUseTool", viaStdio === (marker as never) && createCalls === 1)

  const noPrompt = getCanUseToolFn(undefined, fakeIO as never, () => [])
  const forced = {
    behavior: 'deny',
    message: 'forced',
    decisionReason: { type: 'other', reason: 'rig' },
  }
  const out = await noPrompt(
    { name: 'EchoTool' } as never,
    {} as never,
    {} as never,
    {} as never,
    'tu_p5',
    forced as never,
  )
  check(
    'the no-prompt channel returns forceDecision verbatim (no permission engine call)',
    out === (forced as never),
  )
  check('no StructuredIO channel was built for the no-prompt path', createCalls === 1)
}

// ── S: the interactive stream projection ────────────────────────────────────
const { handleMessageFromStream, isDroppedLateStreamFrame } = streamingMod

type ToolUseEntry = { index: number; contentBlock: AnyMsg; unparsedToolInput: string }
type Projector = {
  feed: (m: unknown) => void
  trace: string[]
  messages: unknown[]
  tombstoned: unknown[]
  ttfts: number[]
  thinking: { thinking: string; isStreaming: boolean } | null
  toolUses: ToolUseEntry[]
  streamingText: string | null
  lastToolOpts: Record<string, unknown> | undefined
  lastToolIdentity: boolean
}
function makeProjector(): Projector {
  const p: Projector = {
    trace: [],
    messages: [],
    tombstoned: [],
    ttfts: [],
    thinking: null,
    toolUses: [],
    streamingText: null,
    lastToolOpts: undefined,
    lastToolIdentity: false,
    feed: () => {},
  }
  p.feed = (m: unknown) =>
    handleMessageFromStream(
      m as never,
      msg => {
        p.messages.push(msg)
        p.trace.push('msg')
      },
      s => p.trace.push('len:' + s),
      mode => p.trace.push('mode:' + String(mode)),
      (f, opts) => {
        const prev = p.toolUses
        p.toolUses = f(p.toolUses as never) as never
        p.lastToolOpts = opts as Record<string, unknown> | undefined
        p.lastToolIdentity = p.toolUses === prev
        p.trace.push('tools')
      },
      msg => {
        p.tombstoned.push(msg)
        p.trace.push('tomb')
      },
      f => {
        p.thinking = f(p.thinking as never) as never
        p.trace.push('think')
      },
      metrics => {
        p.ttfts.push(metrics.ttftMs)
        p.trace.push('ttft:' + metrics.ttftMs)
      },
      f => {
        p.streamingText = f(p.streamingText)
        p.trace.push('text')
      },
    )
  return p
}
const blockStart = (contentBlock: Record<string, unknown>, index = 0): AnyMsg =>
  streamEvent({ type: 'content_block_start', content_block: contentBlock, index })
const textDelta = (text: string): AnyMsg =>
  streamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text }, index: 0 })
const jsonDelta = (partial: string, index: number): AnyMsg =>
  streamEvent({
    type: 'content_block_delta',
    delta: { type: 'input_json_delta', partial_json: partial },
    index,
  })
const thinkingDelta = (thinking: string): AnyMsg =>
  streamEvent({
    type: 'content_block_delta',
    delta: { type: 'thinking_delta', thinking },
    index: 0,
  })
const signatureDelta = (): AnyMsg =>
  streamEvent({
    type: 'content_block_delta',
    delta: { type: 'signature_delta', signature: 'sig' },
    index: 0,
  })
const blockStop = (index = 0): AnyMsg =>
  streamEvent({ type: 'content_block_stop', index })

section('S1 REQUEST START — mode requesting, nothing else')
{
  const p = makeProjector()
  p.feed({ type: 'stream_request_start' })
  check(
    "stream_request_start → exactly [mode:requesting]",
    JSON.stringify(p.trace) === JSON.stringify(['mode:requesting']),
    JSON.stringify(p.trace),
  )
}

section('S2 TTFT — message_start forwards ttftMs when present')
{
  const p = makeProjector()
  p.feed(msgStart(usageOf(1, 1), 123))
  check('ttftMs forwarded', JSON.stringify(p.ttfts) === JSON.stringify([123]), JSON.stringify(p.trace))
  const p2 = makeProjector()
  p2.feed(msgStart(usageOf(1, 1)))
  check('no ttft op without ttftMs', p2.ttfts.length === 0, JSON.stringify(p2.trace))
}

section('S3 BLOCK START — mode routing + tool-use assembly begins')
{
  const p = makeProjector()
  p.feed(blockStart({ type: 'thinking' }))
  check("thinking block → mode 'thinking'", p.trace.includes('mode:thinking'), JSON.stringify(p.trace))
  const p2 = makeProjector()
  p2.feed(blockStart({ type: 'text' }))
  check(
    'text block → streaming-text reset THEN mode responding (order)',
    JSON.stringify(p2.trace) === JSON.stringify(['text', 'mode:responding']),
    JSON.stringify(p2.trace),
  )
  const p3 = makeProjector()
  p3.feed(blockStart({ type: 'tool_use', id: 'tu_s3', name: 'Echo', input: {} }, 4))
  check("tool_use block → mode 'tool-input'", p3.trace.includes('mode:tool-input'))
  check(
    'tool-use entry appended {index, contentBlock, unparsedToolInput: ""}',
    p3.toolUses.length === 1 &&
      p3.toolUses[0]!.index === 4 &&
      p3.toolUses[0]!.unparsedToolInput === '' &&
      (p3.toolUses[0]!.contentBlock as AnyMsg).id === 'tu_s3',
    JSON.stringify(p3.toolUses),
  )
  const p4 = makeProjector()
  p4.feed(blockStart({ type: 'server_tool_use', id: 'x', name: 'y', input: {} }))
  check(
    "server-side blocks → mode 'tool-input' with NO local assembly",
    p4.trace.includes('mode:tool-input') && p4.toolUses.length === 0,
    JSON.stringify(p4.trace),
  )
}

section('S4 DELTAS — text accumulation, silent tool input, signature exclusion')
{
  const p = makeProjector()
  p.feed(blockStart({ type: 'text' }))
  p.feed(textDelta('Hello'))
  p.feed(textDelta(' world'))
  check('text deltas accumulate streamingText', p.streamingText === 'Hello world', String(p.streamingText))
  check(
    'each text delta drives the length counter',
    p.trace.filter(t => t.startsWith('len:')).length === 2,
  )

  const p2 = makeProjector()
  p2.feed(blockStart({ type: 'tool_use', id: 'tu_a', name: 'A', input: {} }, 0))
  p2.feed(blockStart({ type: 'tool_use', id: 'tu_b', name: 'B', input: {} }, 1))
  p2.feed(jsonDelta('{"x":', 0))
  check(
    'input_json_delta accumulates SILENTLY (opts.silent)',
    p2.lastToolOpts?.silent === true,
    JSON.stringify(p2.lastToolOpts),
  )
  check(
    'in-place replace keeps array order stable (no reorder on delta)',
    p2.toolUses.length === 2 &&
      p2.toolUses[0]!.index === 0 &&
      p2.toolUses[0]!.unparsedToolInput === '{"x":' &&
      p2.toolUses[1]!.index === 1,
    JSON.stringify(p2.toolUses),
  )
  p2.feed(jsonDelta('1}', 0))
  check('deltas concatenate per block', p2.toolUses[0]!.unparsedToolInput === '{"x":1}')
  p2.feed(jsonDelta('orphan', 9))
  check(
    'a delta for an unknown index is an IDENTITY no-op (same array reference)',
    p2.lastToolIdentity === true,
  )
  p2.feed(blockStop(0))
  check(
    'content_block_stop commits the silent accumulation (opts.flushSilent)',
    p2.lastToolOpts?.flushSilent === true,
    JSON.stringify(p2.lastToolOpts),
  )

  const p3 = makeProjector()
  p3.feed(thinkingDelta('pondering'))
  check(
    'thinking_delta drives ONLY the length counter (no text op)',
    JSON.stringify(p3.trace) === JSON.stringify(['len:pondering']),
    JSON.stringify(p3.trace),
  )
  const p4 = makeProjector()
  p4.feed(signatureDelta())
  check(
    'signature_delta is fully excluded (token-counter honesty — zero ops)',
    p4.trace.length === 0,
    JSON.stringify(p4.trace),
  )
}

section('S5 MESSAGE BOUNDARIES — delta mode, stop reset with identity no-op')
{
  const p = makeProjector()
  p.feed(msgDelta(usageOf(0, 5), 'end_turn'))
  check("message_delta → mode 'responding'", p.trace.includes('mode:responding'))
  const p2 = makeProjector()
  p2.feed(msgStop())
  check("message_stop → mode 'tool-use'", p2.trace.includes('mode:tool-use'))
  check(
    'message_stop with EMPTY tool uses is an identity no-op (no reset commit)',
    p2.lastToolIdentity === true,
  )
  const p3 = makeProjector()
  p3.feed(blockStart({ type: 'tool_use', id: 'tu_s5', name: 'A', input: {} }, 0))
  p3.feed(msgStop())
  check(
    'message_stop with pending tool uses resets to []',
    p3.toolUses.length === 0 && p3.lastToolIdentity === false,
  )
}

section('S6 SETTLEMENTS — atomic text clear, thinking capture, tombstone, summary')
{
  const p = makeProjector()
  p.feed(blockStart({ type: 'text' }))
  p.feed(textDelta('stream'))
  const settled = asstText('stream')
  p.feed(settled)
  check(
    'settlement clears streamingText in the SAME dispatch as the append (text op then msg op)',
    p.streamingText === null && p.trace.at(-1) === 'msg' && p.trace.at(-2) === 'text',
    JSON.stringify(p.trace),
  )
  check('the settled message appended', p.messages[0] === settled)

  const thinkingMsg = createAssistantMessage({
    content: [{ type: 'thinking', thinking: 'deep thought', signature: '' }] as never,
  })
  const p2 = makeProjector()
  p2.feed(thinkingMsg)
  check(
    'a settled thinking block is captured as non-streaming thinking',
    p2.thinking?.thinking === 'deep thought' && p2.thinking?.isStreaming === false,
    JSON.stringify(p2.thinking),
  )
  check(
    'thinking capture precedes the append (think → text → msg)',
    JSON.stringify(p2.trace) === JSON.stringify(['think', 'text', 'msg']),
    JSON.stringify(p2.trace),
  )

  const p3 = makeProjector()
  const target = asstText('doomed')
  p3.feed({ type: 'tombstone', message: target, uuid: 'tomb-1' })
  check(
    'a tombstone routes to onTombstone with its target — never appended',
    p3.tombstoned[0] === target && p3.messages.length === 0,
    JSON.stringify(p3.trace),
  )
  const p4 = makeProjector()
  p4.feed({ type: 'tool_use_summary', summary: 's', precedingToolUseIds: [], uuid: 'x' })
  check('tool_use_summary is SDK-only — zero interactive ops', p4.trace.length === 0)
}

section('S7 isDroppedLateStreamFrame — the late-frame drop table')
{
  const t = (type: string, aborted: boolean): boolean =>
    isDroppedLateStreamFrame({ type } as never, aborted)
  check('aborted stream_event drops', t('stream_event', true) === true)
  check('aborted stream_request_start drops', t('stream_request_start', true) === true)
  check('aborted assistant settlement flows', t('assistant', true) === false)
  check('aborted user settlement flows', t('user', true) === false)
  check('aborted attachment flows', t('attachment', true) === false)
  check('unaborted stream_event flows', t('stream_event', false) === false)
}

// ── S10 PROJECTION EQUIVALENCE — the recorded REAL query() corpus ───────────
section('S10 EQUIVALENCE — one REAL query() run feeds the interactive projection totally')

// T8-rig subset: a scripted callModel via params.deps drives the REAL query()
// captured before the module mock (activeEngineScript stays null here).
type CallRecord = { model: unknown; messages: unknown[] }
type ModelStep = { kind: 'yield'; value: unknown } | { kind: 'throw'; error: unknown }
const my = (value: unknown): ModelStep => ({ kind: 'yield', value })
function makeModel(script: ModelStep[][]): {
  calls: CallRecord[]
  callModel: (req: never) => AsyncGenerator<never, void>
} {
  const calls: CallRecord[] = []
  async function* callModel(req: {
    messages: unknown[]
    options: Record<string, unknown>
  }): AsyncGenerator<never, void> {
    const idx = calls.length
    calls.push({ model: req.options.model, messages: [...req.messages] })
    const steps = script[idx]
    if (!steps) throw new Error(`model script exhausted at call ${idx}`)
    for (const s of steps) {
      if (s.kind === 'yield') yield s.value as never
      else throw s.error
    }
  }
  return { calls, callModel: callModel as never }
}
function makeRealTool(name: string): never {
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
    call: async (input: Record<string, unknown>) => ({
      data: `echo:${(input?.text as string) ?? ''}`,
    }),
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: String(data),
    }),
  } as never
}
function makeRealCtx(tools: unknown[]): Record<string, unknown> {
  let appState: Record<string, unknown> = {
    ...(getDefaultAppState() as unknown as Record<string, unknown>),
    effortValue: 'high',
  }
  return {
    abortController: new AbortController(),
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
    setAppState: (f: (prev: never) => never) => {
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
const seededUuid = (): (() => string) => {
  let n = 0
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
}

let recordedYields: unknown[] = []
{
  qm.resetCommandQueue()
  const { calls, callModel } = makeModel([
    [
      my(msgStart(usageOf(50, 1))),
      my(asstToolUse('tu_eq', 'EchoTool', { text: 'corpus' })),
      my(msgDelta(usageOf(0, 9), 'tool_use')),
      my(msgStop()),
    ],
    [
      my(msgStart(usageOf(80, 1))),
      my(asstText('equivalence corpus final answer')),
      my(msgDelta(usageOf(0, 7), 'end_turn')),
      my(msgStop()),
    ],
  ])
  const ctx = makeRealCtx([makeRealTool('EchoTool')])
  const gen = realQuery({
    messages: [createUserMessage({ content: 'equivalence corpus prompt' })] as never,
    systemPrompt: ['rig system prompt'] as never,
    userContext: {},
    systemContext: {},
    canUseTool: allowAll as never,
    toolUseContext: ctx as never,
    querySource: 'sdk' as never,
    deps: {
      callModel: callModel as never,
      autocompact: async () => ({ wasCompacted: false }),
      microcompact: (async (messages: unknown[]) => ({ messages })) as never,
      uuid: seededUuid(),
    } as never,
  } as never)
  const yields: unknown[] = []
  let r = await gen.next()
  while (!r.done) {
    yields.push(r.value)
    r = await gen.next()
  }
  await settle()
  recordedYields = yields
  const terminal = r.value as AnyMsg

  check('the corpus run completed', terminal.reason === 'completed', JSON.stringify(terminal))
  check('the corpus made two model calls (tool round + final)', calls.length === 2)

  const p = makeProjector()
  let fed = 0
  let threw = 0
  for (const m of recordedYields) {
    try {
      p.feed(m)
      fed++
    } catch {
      threw++
    }
  }
  check(
    `the projection is TOTAL over the recorded vocabulary (${recordedYields.length} yields, 0 throws)`,
    threw === 0 && fed === recordedYields.length,
    `fed=${fed} threw=${threw}`,
  )
  const settlements = recordedYields.filter(m => {
    const t = (m as AnyMsg).type
    return (
      t !== 'stream_event' &&
      t !== 'stream_request_start' &&
      t !== 'tombstone' &&
      t !== 'tool_use_summary'
    )
  })
  check(
    'every settlement appends, in yield order (projection ≡ the settled stream)',
    p.messages.length === settlements.length &&
      p.messages.every((m, i) => m === settlements[i]),
    `appended=${p.messages.length} settled=${settlements.length}`,
  )
  check('no tombstones in the corpus', p.tombstoned.length === 0)
  check(
    "the projection opened in 'requesting' (the request-start law)",
    p.trace[0] === 'mode:requesting',
    JSON.stringify(p.trace.slice(0, 3)),
  )
  check(
    'streamingText ends cleared after the final settlement',
    p.streamingText === null,
  )
  check(
    'the corpus contains the full event grammar (request starts, stream events, assistant, tool_result user)',
    recordedYields.some(m => (m as AnyMsg).type === 'stream_request_start') &&
      recordedYields.some(m => (m as AnyMsg).type === 'stream_event') &&
      recordedYields.some(m => (m as AnyMsg).type === 'assistant') &&
      recordedYields.some(
        m =>
          (m as AnyMsg).type === 'user' &&
          JSON.stringify((m as AnyMsg).message).includes('tool_result'),
      ),
  )
}

// ── X1 CROSS-SURFACE REPLAY — the same corpus through the ENGINE ────────────
section('X1 CROSS-SURFACE REPLAY — the recorded corpus replayed through QueryEngine')
{
  const r = await runEngine({
    prompt: 'replay corpus prompt',
    steps: recordedYields.map(m => ey(m)),
  })
  const res = lastResult(r.yields)!
  check('the replayed corpus synthesizes success', res.subtype === 'success', String(res.subtype))
  check(
    'the SDK projection carries the same final text the interactive projection saw',
    res.result === 'equivalence corpus final answer',
    JSON.stringify(res.result),
  )
  check(
    "stop_reason re-derived from the corpus deltas ('end_turn')",
    res.stop_reason === 'end_turn',
    String(res.stop_reason),
  )
  check(
    'num_turns 2 (the corpus tool_result user message counted)',
    res.num_turns === 2,
    String(res.num_turns),
  )
  const usage = res.usage as Record<string, number>
  check(
    'usage re-accumulated from the corpus stream events (50+80 in, 9+7 out)',
    usage.input_tokens === 130 && usage.output_tokens === 16,
    JSON.stringify({ i: usage.input_tokens, o: usage.output_tokens }),
  )
  check(
    'the tool round projects on the SDK surface too (assistant tool_use + user tool_result)',
    r.yields.some(
      y => y.type === 'assistant' && JSON.stringify(y.message).includes('tu_eq'),
    ) &&
      r.yields.some(
        y =>
          y.type === 'user' &&
          y.isReplay !== true &&
          JSON.stringify(y.message).includes('tu_eq'),
      ),
  )
}

// ── TRANSCRIPT-PERSISTENCE ORDERING (the ledger-named check) ─────────────
// The engine's recordTranscript discipline is load-bearing for resume
// (fire-and-forget by design): assistant records are fire-and-forget (awaiting blocks the
// generator against claude.ts's in-place usage mutation — the drain-timer
// deadlock), everything else awaits, and a compact boundary pre-flushes the
// preservedSegment tail so a killed subprocess can still relink. The write
// queue is order-preserving, which is what makes the fire-and-forget safe.
// Source-anchored: the cut moved the loop onto queryEvents — these pin
// that the ordering block survived unreordered.
section('T10 ORDERING — transcript persistence discipline (source-anchored)')
{
  const engineSrc = readFileSync(
    new URL('../../src/QueryEngine.ts', import.meta.url),
    'utf8',
  )
  // The recording site: the boundary pre-flush and the record-after-push
  // split live in the one block that starts at the boundary guard.
  const recordAt = engineSrc.indexOf('if (isBoundary && !persistenceDisabled) {')
  const block = recordAt === -1 ? '' : engineSrc.slice(recordAt, recordAt + 1600)
  check(
    'assistant records are fire-and-forget; others await (the drain-timer deadlock rule)',
    // the sites speak the O(new) delta recorder; the
    // fire-and-forget/await split is unchanged.
    /if \(message\.type === 'assistant'\) \{\s*\n\s*void recordDelta\(\)\s*\n\s*\} else \{\s*\n\s*await recordDelta\(\)/.test(
      block,
    ),
  )
  check(
    'the compact boundary pre-flushes the preservedSegment tail BEFORE the push',
    /tailIdx !== -1[\s\S]{0,80}await recordTranscript\(this\.mutableMessages\.slice\(0, tailIdx \+ 1\)\)/.test(
      block,
    ) &&
      block.indexOf('await recordTranscript(this.mutableMessages.slice') !== -1 &&
      block.indexOf('await recordTranscript(this.mutableMessages.slice') <
        block.indexOf('messages.push(message)'),
  )
  check(
    'progress + attachment records stay inline (the dedup-walk anchoring rule)',
    /case 'progress':[\s\S]{0,700}void recordDelta\(\)/.test(engineSrc) &&
      /case 'attachment':[\s\S]{0,400}void recordDelta\(\)/.test(engineSrc),
  )
}

// ── E15 OPERATOR NOTICES — the silent-stop law ──────────────────────────────
// The turn machine emits operator-meaningful notices as 'informational'
// system messages at warning/error level (a repetition stop, a model switch,
// a stream-drop recovery) — "visibly for the operator" by its own comment.
// The headless engine hosts every daemon-hosted session, and the cockpit
// paints from the transcript FILE; an engine that neither yields nor records
// these notices makes the harness's own interventions invisible: the
// operator's turn just goes quiet (the operator sighting's second finding —
// the guard stopped a turn and no frame, no record said so). The law:
// warning/error informational system messages are RECORDED to the transcript
// file; info-level stays unrecorded chrome.
section('E15 OPERATOR NOTICES — warning/error system notices reach the transcript file (the silent-stop law)')
{
  const { createSystemMessage } = await import('../../src/utils/messages/systemMessages.ts')
  const { flushSessionStorage } = await import('../../src/utils/sessionStorage/writer.ts')
  const { readdirSync, statSync } = await import('node:fs')
  const noticeText =
    'E15-MARKER Stopped this turn: the model ran the identical batch past the harness correction.'
  const infoText = 'E15-MARKER background chatter that stays chrome'
  await runEngine({
    steps: [
      ey(asstText('work before the stop')),
      ey(createSystemMessage(noticeText, 'warning')),
      ey(createSystemMessage(infoText, 'info')),
      ey(msgDelta(undefined, 'end_turn')),
    ],
  })
  await flushSessionStorage()
  const home = realpathSync(process.env.MERCURY_CONFIG_DIR!)
  const jsonlContents: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (name.endsWith('.jsonl')) jsonlContents.push(readFileSync(p, 'utf8'))
    }
  }
  walk(home)
  const all = jsonlContents.join('\n')
  const noticeLine = all
    .split('\n')
    .find(line => line.includes('E15-MARKER Stopped this turn'))
  check(
    'a warning-level system notice is RECORDED to the transcript file',
    noticeLine !== undefined,
    'no jsonl line carries the stop notice',
  )
  const noticeRecord = noticeLine
    ? (JSON.parse(noticeLine) as {
        actor?: { role?: string }
        payload?: { kind?: string; level?: string }
      })
    : undefined
  check(
    'the recorded line is a system notice record at warning level',
    noticeRecord?.actor?.role === 'system' &&
      noticeRecord?.payload?.kind === 'notice' &&
      noticeRecord?.payload?.level === 'warning',
    noticeLine?.slice(0, 200) ?? '',
  )
  check(
    'info-level system chatter stays unrecorded (chrome, not record)',
    !all.includes('background chatter that stays chrome'),
  )
}

console.log('')
if (failures > 0) {
  console.log(`native-core runsurface contract: RED (${failures}/${checks} checks failed)`)
  process.exit(1)
}
console.log(`native-core runsurface contract: green (${checks} checks)`)
