#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'bun:test'
import { z } from 'zod/v4'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'runsurface-laws-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'runsurface-daemon-'))
process.env.MERCURY_CREWS_DIR = mkdtempSync(join(tmpdir(), 'runsurface-crews-'))
const ENGINE_CWD = mkdtempSync(join(tmpdir(), 'runsurface-cwd-'))
for (const k of [
  'MERCURY_BARE',
  'MERCURY_EFFORT_LEVEL',
  'MERCURY_MAX_OUTPUT_TOKENS',
  'MERCURY_BLOCKING_LIMIT_OVERRIDE',
  'MERCURY_EAGER_FLUSH',
  'MERCURY_STRUCTURED_OUTPUT_RETRIES',
  'MERCURY_FORCE_READ_FILES',
  'CLAUDE_CREW_NAME',
  'CLAUDE_AGENT_NAME',
  'MERCURY_COMPACT',
  'MERCURY_AUTO_COMPACT',
  'NODE_ENV',
]) {
  delete process.env[k]
}
process.env.ANTHROPIC_API_KEY = 'proof-key-runsurface'

const realQueryModule = await import('../../src/query.ts')
const realQuery = realQueryModule.query
const realQueryEvents = realQueryModule.queryEvents

type EngineQueryCall = {
  querySource: unknown
  maxTurns: unknown
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
    let terminal: Record<string, unknown> = { reason: 'completed' }
    for (const s of activeEngineScript) {
      if (s.kind === 'yield') {
        const v = s.value as { kind?: unknown; terminal?: Record<string, unknown> }
        if (v?.kind === 'run_terminal' && v.terminal !== undefined) {
          terminal = v.terminal
          continue
        }
        if (typeof v?.kind === 'string') yield { ...(s.value as object), seq: ++seq }
        else yield { kind: 'notice', seq: ++seq, message: s.value }
      } else await s.fn(params)
    }
    scriptRanToEnd = true
    yield { kind: 'run_terminal', seq: ++seq, terminal }
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

const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { Conversation } = await import('../../src/rows/turn.ts')
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
const printMod = await import('../../src/cli/print.ts')
const resumeMod = await import('../../src/cli/headless/resume.ts')
const controlMod = await import('../../src/cli/headless/controlHandlers.ts')
const runnerAsksMod = await import('../../src/cli/headless/runnerAsks.ts')
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


type AnyMsg = Record<string, unknown> & { type?: string; subtype?: string }
const settle = (): Promise<void> => new Promise(r => setTimeout(r, 5))

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
  streamEvent({ type: 'message_start', message: { id: 'msg_rig', usage } }, ttftMs)
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

const rowTypes = (yields: AnyMsg[]): string[] =>
  yields.map(y => `${y.type}${typeof y.state === 'string' ? ':' + y.state : typeof y.status === 'string' ? ':' + y.status : ''}`)
const textRows = (yields: AnyMsg[]): string[] =>
  yields.filter(y => y.type === 'text').map(y => String(y.text))
const outcomeOf = (yields: AnyMsg[]): AnyMsg | undefined =>
  yields.filter(y => y.type === 'outcome').at(-1)
const errorOf = (row: AnyMsg | undefined): { message?: string; class?: string; detail?: unknown } =>
  (row?.error ?? {}) as { message?: string; class?: string; detail?: unknown }

type PermissionDecision = Record<string, unknown>
type EngineOpts = {
  prompt?: string
  steps?: EngineStep[]
  tools?: unknown[]
  canUseTool?: (...args: unknown[]) => Promise<PermissionDecision>
  maxTurns?: number
  maxBudgetUsd?: number
  jsonSchema?: Record<string, unknown>
  partialRows?: boolean
  abortController?: AbortController
  engine?: InstanceType<typeof Conversation>
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

function makeEngine(opts: EngineOpts): InstanceType<typeof Conversation> {
  let appState: Record<string, unknown> = {
    ...(getDefaultAppState() as unknown as Record<string, unknown>),
    effortValue: 'high',
  }
  return new Conversation({
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
    readFileState: createFileStateCacheWithSizeLimit(100),
    userSpecifiedModel: MODEL,
    maxTurns: opts.maxTurns,
    maxBudgetUsd: opts.maxBudgetUsd,
    jsonSchema: opts.jsonSchema,
    partialRows: opts.partialRows,
    abortController: opts.abortController,
  })
}

type EngineRun = {
  yields: AnyMsg[]
  calls: EngineQueryCall[]
  engine: InstanceType<typeof Conversation>
}
async function runEngine(opts: EngineOpts): Promise<EngineRun> {
  const engine = opts.engine ?? makeEngine(opts)
  activeEngineScript = opts.steps ?? []
  engineQueryCalls.length = 0
  const yields: AnyMsg[] = []
  try {
    for await (const m of engine.turn(opts.prompt ?? 'engine rig prompt')) {
      yields.push(m as AnyMsg)
    }
  } finally {
    activeEngineScript = null
  }
  await settle()
  return { yields, calls: [...engineQueryCalls], engine }
}

section('E1 TURN ROW + PLAIN TURN — the turn row first, chrome swallowed, the outcome synthesized')
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
  const types = rowTypes(r.yields)
  check('the first row opens the turn', types[0] === 'turn:started', types.join(','))
  const open = r.yields[0]!
  check('the turn row carries the model', open.model === MODEL, String(open.model))
  check('the turn row carries one message id (the prompt)', Array.isArray(open.message_ids) && (open.message_ids as string[]).length === 1, JSON.stringify(open.message_ids))
  check('stream_request_start never reaches the stream', !types.includes('stream_request_start'))
  check('no partial row without partialRows', !types.some(t => t === 'block_start' || t === 'text_delta'))
  check(
    'exactly one text row with the words',
    JSON.stringify(textRows(r.yields)) === JSON.stringify(['the answer.']),
    JSON.stringify(textRows(r.yields)),
  )
  const step = r.yields.find(y => y.type === 'step') as (AnyMsg & { usage?: Record<string, number> }) | undefined
  check('one step row names the model call: the model, the stop word, the usage', step !== undefined && step.model === MODEL && step.stop === 'end_turn' && step.usage?.input_tokens === 100 && step.usage?.output_tokens === 42, JSON.stringify(step))
  const res = outcomeOf(r.yields)!
  check('the outcome is the last row', r.yields.at(-1) === res)
  check('outcome status completed', res.status === 'completed', JSON.stringify(res.status))
  check('outcome steps 1 (one model call)', res.steps === 1, String(res.steps))
  check("the stop word is 'end_turn' (captured from message_delta)", res.stop === 'end_turn', String(res.stop))
  check('the answer is the last text block', res.answer === 'the answer.', String(res.answer))
  const usage = res.usage as Record<string, number>
  check(
    'usage ledger: input from message_start, output from message_delta, settled at message_stop',
    usage.input_tokens === 100 && usage.output_tokens === 42,
    JSON.stringify({ i: usage.input_tokens, o: usage.output_tokens }),
  )
  check('denials empty', JSON.stringify(res.denials) === '[]')
  check('one query() call', r.calls.length === 1, String(r.calls.length))
  check("query called with querySource 'sdk'", r.calls[0]!.querySource === 'sdk')
  check(
    'query rode the turn model',
    r.calls[0]!.mainLoopModel === MODEL,
    String(r.calls[0]!.mainLoopModel),
  )
  check(
    'the conversation gained the prompt + assistant',
    r.engine.getMessages().some(m => (m as AnyMsg).type === 'assistant'),
  )
  check('the fake generator ran to completion', scriptRanToEnd)
}

section('E2 PARTIAL ROWS — the stream rides block_start and delta rows ahead of the settled row; the prompt is never echoed')
{
  const r = await runEngine({
    partialRows: true,
    steps: [
      ey(msgStart(usageOf(10, 1))),
      ey(streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })),
      ey(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial-mode ' } })),
      ey(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answer' } })),
      ey(asstText('partial-mode answer')),
      ey(msgStop()),
    ],
  })
  const types = rowTypes(r.yields)
  const starts = r.yields.filter(y => y.type === 'block_start')
  const deltas = r.yields.filter(y => y.type === 'text_delta')
  check('the block start rides the stream with partialRows', starts.length === 1 && starts[0]!.of === 'text' && starts[0]!.block === 0, types.join(','))
  check('every delta rides the stream, under the message id of message_start', deltas.length === 2 && deltas.every(d => d.message_id === 'msg_rig'), JSON.stringify(deltas))
  check('the deltas join to the settled words', deltas.map(d => String(d.text)).join('') === 'partial-mode answer')
  const lastDelta = r.yields.lastIndexOf(deltas.at(-1)!)
  const textIdx = r.yields.findIndex(y => y.type === 'text')
  check('the settled text row follows its deltas', textIdx > lastDelta, `delta@${lastDelta} text@${textIdx}`)
  check('message_start and message_stop project no row of their own', !types.some(t => t.startsWith('stream_event')))
  check('the prompt is never echoed (no user row exists in the vocabulary)', !types.some(t => t.startsWith('user')))
}

section('E3 STEPS + TOOL ROUNDS — the outcome counts model calls; a tool round rides tool_call then tool_result')
{
  const r = await runEngine({
    steps: [
      ey(asstToolUse('tu_e3', 'EchoTool', { text: 'x' })),
      ey(userToolResult('tu_e3', 'echo:x')),
      ey(asstText('after tools')),
      ey(msgDelta(undefined, 'end_turn')),
    ],
  })
  const res = outcomeOf(r.yields)!
  check('outcome completed', res.status === 'completed', String(res.status))
  check(
    'steps 2 — two model calls (CHARACTERIZED: steps count provider messages, never user messages)',
    res.steps === 2,
    String(res.steps),
  )
  const call = r.yields.find(y => y.type === 'tool_call')
  const result = r.yields.find(y => y.type === 'tool_result')
  check('the tool call projects as a tool_call row with its call id, tool and input', call !== undefined && call.call_id === 'tu_e3' && call.tool === 'EchoTool' && JSON.stringify(call.input) === JSON.stringify({ text: 'x' }), JSON.stringify(call))
  check('the tool result projects as a tool_result row with the same call id and the output', result !== undefined && result.call_id === 'tu_e3' && result.status === 'ok' && result.output === 'echo:x', JSON.stringify(result))
  check('the result follows the call', r.yields.indexOf(call!) < r.yields.indexOf(result!))

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
  const texts = r2.yields.filter(y => y.type === 'text')
  check(
    'CHARACTERIZED: a multi-block assistant projects one text row per block, under one message id',
    JSON.stringify(textRows(r2.yields)) === JSON.stringify(['block one', 'block two']) &&
      texts.length === 2 && texts[0]!.block === 0 && texts[1]!.block === 1 && texts[0]!.message_id === texts[1]!.message_id,
    JSON.stringify(texts),
  )
  check('…and one step', outcomeOf(r2.yields)!.steps === 1 && r2.yields.filter(y => y.type === 'step').length === 1)
}

section('E4 EMPTY ASSISTANT — no row, no answer, still stored')
{
  const before = makeEngine({})
  const r = await runEngine({
    engine: before,
    steps: [ey(asstText('')), ey(msgDelta(undefined, 'end_turn'))],
  })
  check(
    'zero text rows for an empty assistant (the placeholder is not the model speaking)',
    r.yields.filter(y => y.type === 'text').length === 0,
    rowTypes(r.yields).join(','),
  )
  check(
    'the empty assistant still landed in the conversation (CHARACTERIZED asymmetry)',
    r.engine.getMessages().some(m => (m as AnyMsg).type === 'assistant'),
  )
  const res = outcomeOf(r.yields)!
  check('the outcome is still completed', res.status === 'completed', String(res.status))
  check("the answer is '' — the placeholder never leaks into the outcome", res.answer === '', JSON.stringify(res.answer))
}

section('E5 STOP WORD — latest non-null wins across synthetic + delta sources')
{
  const stamped = asstText('stamped')
  ;(stamped.message as Record<string, unknown>).stop_reason = 'tool_use'
  const r = await runEngine({
    steps: [ey(stamped), ey(msgDelta(undefined, 'end_turn'))],
  })
  check(
    'delta after synthetic: end_turn wins',
    outcomeOf(r.yields)!.stop === 'end_turn',
    String(outcomeOf(r.yields)!.stop),
  )

  const stamped2 = asstText('stamped2')
  ;(stamped2.message as Record<string, unknown>).stop_reason = 'stop_sequence'
  const r2 = await runEngine({
    steps: [ey(msgDelta(undefined, 'end_turn')), ey(stamped2)],
  })
  check(
    'synthetic after delta: the synthetic stop word wins (yield order, not source)',
    outcomeOf(r2.yields)!.stop === 'stop_sequence',
    String(outcomeOf(r2.yields)!.stop),
  )
  const r3 = await runEngine({
    steps: [ey(msgDelta(undefined, 'end_turn')), ey(asstText('null-shaped'))],
  })
  check(
    'a null (streamed-shape) assistant never clobbers the captured stop word',
    outcomeOf(r3.yields)!.stop === 'end_turn',
    String(outcomeOf(r3.yields)!.stop),
  )
}

section('E6 MAX-TURNS — turn_limit from the attachment, generator closed early')
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
  const res = outcomeOf(r.yields)!
  check('outcome status turn_limit', res.status === 'turn_limit', String(res.status))
  check('the error class is turn_limit', errorOf(res).class === 'turn_limit', String(errorOf(res).class))
  check(
    'the error names the cap',
    String(errorOf(res).message).includes('maximum number of turns (3)'),
    JSON.stringify(res.error),
  )
  check(
    'the post-attachment assistant never projects',
    !textRows(r.yields).includes('NEVER PROJECTED'),
  )
  check('the generator was closed early (finally ran, steps did not complete)', scriptFinallyRan && !scriptRanToEnd)
  check('maxTurns was passed through to query()', r.calls[0]!.maxTurns === 3)
}

section('E7 ATTACHMENTS — structured_output capture; a queued_command is the conversation\'s, never a row')
{
  const r = await runEngine({
    steps: [
      ey(createAttachmentMessage({ type: 'structured_output', data: { answer: 42 } } as never)),
      ey(asstText('done')),
      ey(msgDelta(undefined, 'end_turn')),
    ],
  })
  const res = outcomeOf(r.yields)!
  check(
    'the structured_output attachment lands on the completed outcome',
    JSON.stringify(res.structured) === JSON.stringify({ answer: 42 }),
    JSON.stringify(res.structured),
  )

  const srcUuid = '99999999-9999-4999-8999-999999999999'
  const queued = createAttachmentMessage({
    type: 'queued_command',
    prompt: 'queued follow-up',
    source_uuid: srcUuid,
  } as never)
  const r2 = await runEngine({
    steps: [ey(queued), ey(asstText('after drain')), ey(msgDelta(undefined, 'end_turn'))],
  })
  check(
    'a queued_command attachment lands in the conversation',
    JSON.stringify(r2.engine.getMessages()).includes('queued follow-up'),
  )
  check(
    'and never on the row stream (the caller sent it; the rows never echo input)',
    !r2.yields.some(y => JSON.stringify(y).includes('queued follow-up')),
  )
}

section('E8 COMPACT BOUNDARY — the ended compaction row + the memory release')
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
  const ended = r.yields.find(y => y.type === 'compaction')
  check('a compaction row rides the stream', ended !== undefined, rowTypes(r.yields).join(','))
  check(
    'the row is ended, landed, with the trigger and the tokens before',
    ended?.state === 'ended' && ended?.exit === 'landed' && ended?.trigger === 'auto' && ended?.tokens_before === 900,
    JSON.stringify(ended),
  )
  const stored = r.engine.getMessages()
  check(
    'the conversation was RELEASED to the boundary (first stored message IS the boundary)',
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

section('E9 API-ERROR — system api_error projects to a retry wait row, categorized')
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
  const retry = r.yields.find(y => y.type === 'wait' && y.state === 'retry')
  check('a retry wait row rides the stream', retry !== undefined, rowTypes(r.yields).join(','))
  check('attempt/of/delay projected', retry?.attempt === 1 && retry?.of === 10 && retry?.delay_ms === 1200, JSON.stringify(retry))
  check('the http status projected', retry?.http_status === 529, String(retry?.http_status))
  check('the reason is a categorized word', typeof retry?.reason === 'string' && (retry.reason as string).length > 0, String(retry?.reason))
  check('the turn still completes after the retry', outcomeOf(r.yields)!.status === 'completed')
}

section('E10 RETRACTION + SUMMARY — the retraction is a partial row; the summary never reaches the stream')
{
  const orphan = asstText('to be tombstoned')
  const steps = (): EngineStep[] => [
    ey(orphan),
    ey({ kind: 'assistant_retracted', message: orphan }),
    ey({
      type: 'tool_use_summary',
      summary: 'did the things',
      precedingToolUseIds: ['tu_s'],
      uuid: 'rig-sum',
    }),
    ey(asstText('final')),
    ey(msgDelta(undefined, 'end_turn')),
  ]
  const r = await runEngine({ steps: steps() })
  check('the interactive tool-use summary never reaches the row stream', !r.yields.some(y => y.type === 'tool_use_summary'), rowTypes(r.yields).join(','))
  check(
    'without partialRows the retraction is invisible (CHARACTERIZED: a partial-row matter)',
    !r.yields.some(y => y.type === 'retracted'),
  )
  check(
    'the retracted words were already yielded as their row',
    textRows(r.yields).includes('to be tombstoned'),
  )
  const r2 = await runEngine({ partialRows: true, steps: steps() })
  const retracted = r2.yields.find(y => y.type === 'retracted')
  check('with partialRows the retraction rides a retracted row naming the message', retracted !== undefined && retracted.message_id === (orphan.message as AnyMsg).id, JSON.stringify(retracted))
}

section('E11 FAILED TERMINAL — model_error settles failed; the turn-scoped error watermark is the detail')
{
  logError(new Error('PRE-TURN error — must be excluded'))
  const r = await runEngine({
    steps: [
      { kind: 'do', fn: () => logError(new Error('IN-TURN rig error')) },
      ey(asstToolUse('tu_ede', 'EchoTool', { text: 'x' })),
      ey({ kind: 'run_terminal', terminal: { reason: 'model_error', error: new Error('the rig model failed') } }),
    ],
  })
  const res = outcomeOf(r.yields)!
  check('outcome status failed', res.status === 'failed', String(res.status))
  check('the error class is model', errorOf(res).class === 'model', String(errorOf(res).class))
  check('the message is the terminal\'s error', errorOf(res).message === 'the rig model failed', String(errorOf(res).message))
  const detail = (errorOf(res).detail ?? []) as string[]
  check(
    'the in-turn error is included (watermark scope)',
    detail.some(e => e.includes('IN-TURN rig error')),
    JSON.stringify(detail),
  )
  check(
    'the pre-turn error is EXCLUDED (watermark scope)',
    !detail.some(e => e.includes('PRE-TURN error')),
    JSON.stringify(detail),
  )
  check('the open step still flushes before the outcome', r.yields.filter(y => y.type === 'step').length === 1 && r.yields.at(-1) === res)
}

section('E12 END-TURN WITHOUT CONTENT — a content-free completed terminal is a completed outcome with an empty answer')
{
  const r = await runEngine({
    steps: [ey(msgDelta(undefined, 'end_turn'))],
  })
  const res = outcomeOf(r.yields)!
  check(
    'outcome completed on a content-free end_turn turn',
    res.status === 'completed',
    String(res.status),
  )
  check("answer ''", res.answer === '', JSON.stringify(res.answer))
  check("stop 'end_turn'", res.stop === 'end_turn')
  check('steps 0', res.steps === 0, String(res.steps))
}

section('E13 DENIALS — recorded via the wrap; the Agent tool under its own name; allow silent')
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
  const denials = (outcomeOf(r.yields)!.denials ?? []) as AnyMsg[]
  check('two denials recorded', denials.length === 2, JSON.stringify(denials))
  check(
    'the Agent tool reports under its own name',
    denials[0]?.tool === 'Agent',
    String(denials[0]?.tool),
  )
  check(
    'a denial carries the call id and the input',
    denials[0]?.call_id === 'tu_perm1' &&
      JSON.stringify(denials[0]?.input) === JSON.stringify({ x: 1 }),
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
    ((outcomeOf(r2.yields)!.denials ?? []) as unknown[]).length === 0,
  )
}

section('E14 BUDGET — a zero budget preempts after the FIRST yield, before content')
{
  const r = await runEngine({
    maxBudgetUsd: 0,
    steps: [
      ey({ type: 'stream_request_start' }),
      ey(asstText('NEVER PROJECTED — budget preempts first')),
    ],
  })
  const res = outcomeOf(r.yields)!
  check('outcome status budget_limit', res.status === 'budget_limit', String(res.status))
  check('the error class is budget_limit', errorOf(res).class === 'budget_limit')
  check(
    'the error names the budget',
    String(errorOf(res).message).includes('maximum budget of $0'),
    JSON.stringify(res.error),
  )
  check(
    'CHARACTERIZED: the check runs after EVERY message type — zero text rows',
    r.yields.filter(y => y.type === 'text').length === 0,
    rowTypes(r.yields).join(','),
  )
  check('the generator was closed early', scriptFinallyRan && !scriptRanToEnd)
}

section('E15 SO RETRY CEILING — 5 synthetic-output calls ⇒ schema_unmet on the user yield')
{
  const steps: EngineStep[] = []
  for (let i = 1; i <= 5; i++) {
    steps.push(ey(asstToolUse(`tu_so_${i}`, SYNTHETIC_OUTPUT_TOOL_NAME, { v: i })))
    steps.push(ey(userToolResult(`tu_so_${i}`, 'retry')))
  }
  steps.push(ey(asstText('NEVER REACHED')))
  const r = await runEngine({ jsonSchema: { type: 'object' }, steps })
  const res = outcomeOf(r.yields)!
  check(
    'outcome status schema_unmet',
    res.status === 'schema_unmet',
    String(res.status),
  )
  check(
    'the detail names the retry ceiling (default 5)',
    Array.isArray(errorOf(res).detail) && String((errorOf(res).detail as string[])[0]).includes('after 5 attempts'),
    JSON.stringify(res.error),
  )
  check('steps 5 (five model calls)', res.steps === 5, String(res.steps))
  check(
    'the post-ceiling assistant never projects',
    !textRows(r.yields).includes('NEVER REACHED'),
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
      return outcomeOf(r2.yields)!.status === 'completed'
    })(),
  )
}

section('E16 NO-QUERY — local command: the turn row, a command_output row, the answer, zero query calls')
{
  const r = await runEngine({ prompt: '/rigcmd hello', steps: [] })
  check('zero query() calls on the no-query path', r.calls.length === 0, String(r.calls.length))
  check('the turn row still opens the turn', rowTypes(r.yields)[0] === 'turn:started')
  const output = r.yields.find(y => y.type === 'command_output')
  check(
    'the local output projects as a command_output row — TAGS STRIPPED, the command named',
    output !== undefined && output.text === 'local says hello' && output.command === '/rigcmd',
    JSON.stringify(output ?? null),
  )
  const res = outcomeOf(r.yields)!
  check('outcome completed', res.status === 'completed')
  check(
    'the answer is the local command\'s own words',
    res.answer === 'local says hello',
    JSON.stringify(res.answer),
  )
  check('steps 0 on the no-query path', res.steps === 0, String(res.steps))
  check('no stop word on the no-query outcome', res.stop === undefined)
}

section('E17 INTERRUPT — interrupt() aborts the shared controller; the projection is abort-blind')
{
  const controller = new AbortController()
  let observedAborted: boolean | null = null
  let engineRef: InstanceType<typeof Conversation> | null = null
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
    textRows(r.yields).includes('after interrupt — still projected'),
  )
  check(
    'the run still synthesizes its outcome (abort semantics live in query(), not the turn)',
    outcomeOf(r.yields) !== undefined,
  )
}

section('E18 MULTI-TURN — state persists across turns; setModel applies next turn')
{
  const engine = makeEngine({})
  const r1 = await runEngine({
    engine,
    prompt: 'first turn prompt',
    steps: [ey(asstText('turn one answer')), ey(msgDelta(undefined, 'end_turn'))],
  })
  check('turn 1 completed', outcomeOf(r1.yields)!.status === 'completed')
  check('turn 1 is turn 1', r1.yields[0]!.turn === 1 && outcomeOf(r1.yields)!.turn === 1)
  engine.setModel(MODEL2)
  const r2 = await runEngine({
    engine,
    prompt: 'second turn prompt',
    steps: [ey(asstText('turn two answer')), ey(msgDelta(undefined, 'end_turn'))],
  })
  check('turn 2 opens with its own turn row (one per turn)', rowTypes(r2.yields)[0] === 'turn:started' && r2.yields[0]!.turn === 2)
  check(
    'setModel applies to the next turn',
    r2.yields[0]!.model === MODEL2 && r2.calls[0]!.mainLoopModel === MODEL2,
    `turn=${String(r2.yields[0]!.model)} query=${String(r2.calls[0]!.mainLoopModel)}`,
  )
  const turn2Input = r2.calls[0]!.messages
  check(
    "turn 2's query input carries turn 1's conversation (state persists)",
    JSON.stringify(turn2Input).includes('turn one answer') &&
      JSON.stringify(turn2Input).includes('first turn prompt'),
  )
  check(
    'the conversation holds both turns',
    JSON.stringify(engine.getMessages()).includes('turn two answer'),
  )
}

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

section('P4 resolvePermissionModeTransition — apollo refused outside the terminal, bypass gated, an unknown word refused, success transition')
{
  const { resolvePermissionModeTransition } = controlMod
  const baseCtx = {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    isBypassPermissionsModeAvailable: false,
  }

  const apollo = resolvePermissionModeTransition('apollo' as never, baseCtx as never)
  check(
    'apollo is refused in SDK/print mode (a refusal with its sentence)',
    apollo.ok === false && /apollo/i.test(apollo.ok ? '' : apollo.error),
    JSON.stringify(apollo),
  )

  const sovereign = resolvePermissionModeTransition('sovereign' as never, baseCtx as never)
  check(
    'sovereign is refused without the launch-time eligibility',
    sovereign.ok === false && (sovereign.ok ? '' : sovereign.error).includes('--sovereign'),
    JSON.stringify(sovereign),
  )

  for (const word of ['allowAll', 'strategy', 'bubble', 'frobnicate']) {
    const unknown = resolvePermissionModeTransition(word as never, baseCtx as never)
    check(
      `'${word}' is not a permission mode: refused in one sentence naming the word and the list`,
      unknown.ok === false && (unknown.ok ? '' : unknown.error).includes(`'${word}' is not a permission mode`) && (unknown.ok ? '' : unknown.error).includes('default, dontAsk, implement, sovereign, flow, apollo'),
      JSON.stringify(unknown),
    )
  }

  const afterSwitch = resolvePermissionModeTransition('implement' as never, baseCtx as never)
  check(
    "a plain mode switch succeeds and the context carries mode 'implement'",
    afterSwitch.ok === true && (afterSwitch.ok ? (afterSwitch.context as { mode?: string }).mode : '') === 'implement',
    JSON.stringify(afterSwitch),
  )
}

section('P5 createRuleOnlyAsks — a run with no host answers by the rules; forceDecision passthrough')
{
  const { createRuleOnlyAsks } = runnerAsksMod
  const host = createRuleOnlyAsks()
  check('a hostless run parks no asks and holds none', host.parkedAsks() === 0 && host.pendingControlRequestCount() === 0)

  const noPrompt = host.createCanUseTool()
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
    'the hostless road returns forceDecision verbatim (no permission engine call)',
    out === (forced as never),
  )
}

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

section('S10 EQUIVALENCE — one REAL query() run feeds the interactive projection totally')

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

section('X1 CROSS-SURFACE REPLAY — the recorded corpus replayed through the turn')
{
  const r = await runEngine({
    prompt: 'replay corpus prompt',
    steps: recordedYields.map(m => ey(m)),
  })
  const res = outcomeOf(r.yields)!
  check('the replayed corpus settles completed', res.status === 'completed', String(res.status))
  check(
    'the row projection carries the same final text the interactive projection saw',
    res.answer === 'equivalence corpus final answer',
    JSON.stringify(res.answer),
  )
  check(
    "the stop word re-derived from the corpus deltas ('end_turn')",
    res.stop === 'end_turn',
    String(res.stop),
  )
  check(
    'steps 2 (the corpus carried two model calls)',
    res.steps === 2,
    String(res.steps),
  )
  const usage = res.usage as Record<string, number>
  check(
    'usage re-accumulated from the corpus stream events (50+80 in, 9+7 out)',
    usage.input_tokens === 130 && usage.output_tokens === 16,
    JSON.stringify({ i: usage.input_tokens, o: usage.output_tokens }),
  )
  check(
    'the tool round projects on the row surface too (tool_call + tool_result under one call id)',
    r.yields.some(y => y.type === 'tool_call' && y.call_id === 'tu_eq') &&
      r.yields.some(y => y.type === 'tool_result' && y.call_id === 'tu_eq'),
  )
}

section('T10 ORDERING — transcript persistence discipline (source-anchored)')
{
  const engineSrc = readFileSync(
    new URL('../../src/rows/turn.ts', import.meta.url),
    'utf8',
  )
  const recordAt = engineSrc.indexOf('if (isBoundary && !persistenceDisabled) {')
  const block = recordAt === -1 ? '' : engineSrc.slice(recordAt, recordAt + 1600)
  check(
    'assistant records are fire-and-forget; others await (the drain-timer deadlock rule)',
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
      /case 'attachment':[\s\S]{0,1200}await recordDelta\(\)[\s\S]{0,300}void recordDelta\(\)/.test(engineSrc),
  )
}

section('E15 OPERATOR NOTICES — warning/error system notices reach the transcript file (the silent-stop law)')
{
  const { createSystemMessage } = await import('../../src/utils/messages/systemMessages.ts')
  const { flushSessionStorage } = await import('../../src/utils/sessionStorage/writer.ts')
  const { readdirSync, statSync } = await import('node:fs')
  const noticeText =
    'E15-MARKER a warning the operator must see after this turn.'
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
    .find(line => line.includes('E15-MARKER a warning the operator must see'))
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
