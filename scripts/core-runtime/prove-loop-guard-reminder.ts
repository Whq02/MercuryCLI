#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

const homeRoot = process.env.MERCURY_CONFIG_DIR ?? tmpdir()
mkdirSync(homeRoot, { recursive: true })
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(homeRoot, 'loop-guard-reminder-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'loop-guard-reminder-daemon-'))
process.env.MERCURY_TEAMS_DIR = mkdtempSync(join(tmpdir(), 'loop-guard-reminder-teams-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
for (const k of [
  'MERCURY_BARE',
  'MERCURY_EFFORT_LEVEL',
  'MERCURY_MAX_OUTPUT_TOKENS',
  'MERCURY_COMPACT',
  'MERCURY_AUTO_COMPACT',
  'MERCURY_SCRIPTED_STREAM',
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
const { createAssistantMessage, createUserMessage } = await import(
  '../../src/utils/messages/factories.ts'
)
const { normalizeMessagesForAPI } = await import('../../src/utils/messages/apiView.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const queueStore = await import('../../src/input-core/command-queue.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — loop-guard reminder prover exceeded 120s')
  process.exit(1)
}, 120_000)
watchdog.unref?.()

const GENTLE = 'Loop check: this is the third identical tool call, and its result has not changed.'
const NAMED_FIVE = 'Loop notice: Grep has been called 5 times with identical arguments'
const NAMED_EIGHT = 'Loop notice: Grep has been called 8 times with identical arguments'
const ANY_NOTICE = /Loop (check|notice|guard)/

type AnyMsg = Record<string, unknown> & { type?: string }
const MODEL = 'claude-opus-4-8'

type ResultScript = (name: string, input: Record<string, unknown>, callIndex: number) => string
const identicalResults: ResultScript = (name, input) =>
  `${name}:${JSON.stringify(Object.fromEntries(Object.entries(input).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))}`
let resultFor: ResultScript = identicalResults
let callIndex = 0

function makeTool(name: string): never {
  return {
    name,
    async description() {
      return 'rig tool'
    },
    async prompt() {
      return 'rig tool'
    },
    inputSchema: z.object({}).catchall(z.unknown()),
    userFacingName: () => name,
    isEnabled: () => true,
    isConcurrencySafe: () => false,
    isReadOnly: () => true,
    isMcp: false,
    needsPermissions: () => false,
    async validateInput() {
      return { result: true }
    },
    async call(input: Record<string, unknown>) {
      return { data: resultFor(name, input, callIndex++) }
    },
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: String(data),
    }),
  } as never
}

const TOOLS = [makeTool('Grep'), makeTool('Read'), makeTool('Bash'), makeTool('TaskOutput')]

type CtxShape = { agentId?: string; preserveToolResults?: boolean; tools?: unknown[] }

function makeCtx(shape: CtxShape = {}): { ctx: Record<string, unknown>; abortController: AbortController } {
  let appState: Record<string, unknown> = {
    ...(getDefaultAppState() as unknown as Record<string, unknown>),
    effortValue: 'high',
  }
  const abortController = new AbortController()
  const ctx: Record<string, unknown> = {
    abortController,
    options: {
      commands: [],
      tools: shape.tools ?? TOOLS,
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
    setAppState: (f: (prev: never) => never): void => {
      appState = f(appState as never) as unknown as Record<string, unknown>
    },
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId: shape.agentId,
    ...(shape.preserveToolResults === undefined ? {} : { preserveToolResults: shape.preserveToolResults }),
  }
  return { ctx, abortController }
}

type CallRecord = { messages: unknown[] }

function makeModel(turnFor: (index: number) => unknown[] | undefined): { calls: CallRecord[]; callModel: unknown } {
  const calls: CallRecord[] = []
  async function* callModel(req: { messages: unknown[] }): AsyncGenerator<never, void> {
    const idx = calls.length
    calls.push({ messages: [...req.messages] })
    const turn = turnFor(idx)
    if (!turn) throw new Error(`model script exhausted at call ${idx}`)
    for (const m of turn) yield m as never
  }
  return { calls, callModel }
}

const allowAll = async (_tool: unknown, input: Record<string, unknown>) =>
  ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }) as never
const denyAll = async () =>
  ({ behavior: 'deny', message: 'denied by the rig', decisionReason: { type: 'other', reason: 'rig' } }) as never

let idSeq = 0
function toolTurn(name: string, input: Record<string, unknown>): { turn: unknown[]; id: string } {
  const id = `tu_${++idSeq}`
  const m = createAssistantMessage({
    content: [{ type: 'tool_use', id, name, input }] as never,
  })
  m.message.stop_reason = 'tool_use'
  return { turn: [m], id }
}
function parallelTurn(calls: Step[], shape: 'per-block' | 'one-envelope' = 'per-block'): { turn: unknown[]; ids: string[] } {
  const ids = calls.map(() => `tu_${++idSeq}`)
  if (shape === 'one-envelope') {
    const m = createAssistantMessage({
      content: calls.map((call, i) => ({ type: 'tool_use', id: ids[i], name: call.name, input: call.input })) as never,
    })
    m.message.stop_reason = 'tool_use'
    return { turn: [m], ids }
  }
  const responseId = `msg_round_${idSeq}`
  const envelopes = calls.map((call, i) => {
    const m = createAssistantMessage({
      content: [{ type: 'tool_use', id: ids[i], name: call.name, input: call.input }] as never,
    })
    m.message.id = responseId
    m.message.stop_reason = i === calls.length - 1 ? 'tool_use' : null
    return m
  })
  return { turn: envelopes, ids }
}
function textTurn(text: string): unknown[] {
  const m = createAssistantMessage({ content: text })
  m.message.stop_reason = 'end_turn'
  return [m]
}

type Step = { name: string; input: Record<string, unknown> }
type Run = {
  calls: CallRecord[]
  yields: AnyMsg[]
  ids: string[]
  terminal: Record<string, unknown>
}

async function runScript(
  steps: Step[],
  opts: {
    messages?: unknown[]
    canUseTool?: unknown
    results?: ResultScript
    ctx?: CtxShape
    onYield?: (message: AnyMsg, yields: AnyMsg[]) => void
    rounds?: Step[][]
    roundShape?: 'per-block' | 'one-envelope'
  } = {},
): Promise<Run> {
  resultFor = opts.results ?? identicalResults
  callIndex = 0
  const ids: string[] = []
  const { calls, callModel } = makeModel(i => {
    if (opts.rounds !== undefined) {
      const round = opts.rounds[i]
      if (!round) return textTurn('done')
      const { turn, ids: roundIds } = parallelTurn(round, opts.roundShape)
      ids.push(...roundIds)
      return turn
    }
    const step = steps[i]
    if (!step) return textTurn('done')
    const { turn, id } = toolTurn(step.name, step.input)
    ids.push(id)
    return turn
  })
  const rig = makeCtx(opts.ctx)
  const gen = query({
    messages: (opts.messages ?? [createUserMessage({ content: 'please do the thing' })]) as never,
    systemPrompt: ['rig system prompt'] as never,
    userContext: {},
    systemContext: {},
    canUseTool: (opts.canUseTool ?? allowAll) as never,
    toolUseContext: rig.ctx as never,
    querySource: 'sdk' as never,
    deps: {
      callModel: callModel as never,
      autocompact: (async () => ({ wasCompacted: false })) as never,
      microcompact: (async (messages: unknown[]) => ({ messages })) as never,
      uuid: (() => {
        let n = 0
        return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
      })(),
    },
  }) as AsyncGenerator<AnyMsg, Record<string, unknown>>
  const yields: AnyMsg[] = []
  let r = await gen.next()
  while (!r.done) {
    yields.push(r.value)
    opts.onYield?.(r.value, yields)
    r = await gen.next()
  }
  return { calls, yields, ids, terminal: r.value }
}

function requestText(run: Run, index: number): string {
  return JSON.stringify(run.calls[index]?.messages ?? [])
}
function wireText(run: Run, index: number): string {
  return JSON.stringify(normalizeMessagesForAPI((run.calls[index]?.messages ?? []) as never))
}
function firstRequestWith(run: Run, needle: string | RegExp): number {
  for (let i = 0; i < run.calls.length; i++) {
    const text = requestText(run, i)
    if (typeof needle === 'string' ? text.includes(needle) : needle.test(text)) return i
  }
  return -1
}
function resultYieldIndex(run: Run, toolUseId: string): number {
  return run.yields.findIndex(m => {
    if (m.type !== 'user') return false
    const content = (m as { message?: { content?: unknown } }).message?.content
    return (
      Array.isArray(content) &&
      content.some(
        (b: { type?: string; tool_use_id?: string }) =>
          b.type === 'tool_result' && b.tool_use_id === toolUseId,
      )
    )
  })
}
function reminderYieldIndexes(run: Run): number[] {
  const out: number[] = []
  run.yields.forEach((m, i) => {
    if (m.type !== 'attachment') return
    const att = (m as { attachment?: { type?: string; content?: unknown } }).attachment
    if (att?.type === 'critical_system_reminder' && ANY_NOTICE.test(String(att.content))) out.push(i)
  })
  return out
}
function noticeRows(run: Run): AnyMsg[] {
  return run.yields.filter(
    m => m.type === 'system' && ANY_NOTICE.test(String((m as { content?: unknown }).content ?? '')),
  )
}
function toolResultText(run: Run, toolUseId: string): string {
  const m = run.yields[resultYieldIndex(run, toolUseId)] as { message?: { content?: Array<{ content?: unknown }> } } | undefined
  return String(m?.message?.content?.[0]?.content ?? '')
}

const GREP = { pattern: 'needle', path: '/tmp/haystack' }
const GREP_REORDERED = { path: '/tmp/haystack', pattern: 'needle' }

section('R1 — the same Grep nine times: a notice after the 3rd, 5th and 8th results, none after the others, nothing blocked')
{
  const steps: Step[] = Array.from({ length: 9 }, () => ({ name: 'Grep', input: GREP }))
  const run = await runScript(steps)
  check('the model was called ten times (nine tool rounds and the settling text) — nothing was blocked', run.calls.length === 10, `calls=${run.calls.length}`)
  check('every one of the nine Greps ran and returned its own result', run.ids.every(id => toolResultText(run, id).startsWith('Grep:')), run.ids.map(id => toolResultText(run, id)).join(' | '))
  check('no notice rides in the request after the 1st result', !ANY_NOTICE.test(requestText(run, 1)))
  check('no notice rides in the request after the 2nd result', !ANY_NOTICE.test(requestText(run, 2)))
  check('the gentle sentence rides in the request after the 3rd result', requestText(run, 3).includes(GENTLE), `request 3: ${requestText(run, 3).slice(-400)}`)
  check('the gentle sentence first appears in the 4th request (never earlier)', firstRequestWith(run, GENTLE) === 3, `first=${firstRequestWith(run, GENTLE)}`)
  check('no new notice after the 4th result', !requestText(run, 4).includes(NAMED_FIVE) && !requestText(run, 4).includes(NAMED_EIGHT))
  check('the named notice with the run length 5 rides after the 5th result', requestText(run, 5).includes(NAMED_FIVE), `request 5: ${requestText(run, 5).slice(-600)}`)
  check('the 5-notice carries a capped preview of the arguments', /identical arguments \([^)]*needle/.test(requestText(run, 5)))
  check('no new notice after the 6th or 7th result', !requestText(run, 7).includes(NAMED_EIGHT), `first8=${firstRequestWith(run, NAMED_EIGHT)}`)
  check('the named notice with the run length 8 rides after the 8th result', requestText(run, 8).includes(NAMED_EIGHT), `request 8: ${requestText(run, 8).slice(-600)}`)
  check('the notice reaches the model as a system reminder on the wire (the attachment row, enveloped at the wire door behind the tool result)', /<system-reminder>[^"]*Loop check/.test(wireText(run, 3)), wireText(run, 3).slice(-400))
  const reminders = reminderYieldIndexes(run)
  check('exactly three model-facing reminders were yielded in the whole run (3, 5, 8)', reminders.length === 3, `reminders=${reminders.length}`)
  const third = resultYieldIndex(run, run.ids[2]!)
  const fourth = resultYieldIndex(run, run.ids[3]!)
  check('the first reminder is yielded AFTER the 3rd result and BEFORE the 4th', reminders[0] !== undefined && reminders[0] > third && reminders[0] < fourth, `third=${third} reminder=${reminders[0]} fourth=${fourth}`)
  const rows = noticeRows(run)
  check('each notice is recorded as an informational system row for the operator', rows.length === 3 && rows.every(r => (r as { level?: string }).level === 'info'), `rows=${rows.length} levels=${rows.map(r => (r as { level?: string }).level).join(',')}`)
  check('the operator row names the tool and the run length', rows.some(r => /Grep.*3 times/.test(String((r as { content?: unknown }).content))), rows.map(r => String((r as { content?: unknown }).content)).join(' | '))
  check('the run completed normally (advisory only)', run.terminal.reason === 'completed', JSON.stringify(run.terminal))
}

section('R2 — a different call between repeats resets the count: Grep Grep Read Grep Grep is silent')
{
  const run = await runScript([
    { name: 'Grep', input: GREP },
    { name: 'Grep', input: GREP },
    { name: 'Read', input: { file_path: '/tmp/other' } },
    { name: 'Grep', input: GREP },
    { name: 'Grep', input: GREP },
  ])
  check('six model calls, no notice anywhere', run.calls.length === 6 && firstRequestWith(run, ANY_NOTICE) === -1, `first=${firstRequestWith(run, ANY_NOTICE)}`)
  check('no reminder attachment and no notice row were yielded', reminderYieldIndexes(run).length === 0 && noticeRows(run).length === 0)
}

section('R3 — a real user turn between repeats resets the chain: two Greps, a new prompt, two more Greps is silent')
{
  const first = await runScript([
    { name: 'Grep', input: GREP },
    { name: 'Grep', input: GREP },
  ])
  check('the first prompt ran its two Greps silently', first.calls.length === 3 && firstRequestWith(first, ANY_NOTICE) === -1)
  const carried = first.yields.filter(m => m.type === 'user' || m.type === 'assistant' || m.type === 'attachment')
  const second = await runScript(
    [
      { name: 'Grep', input: GREP },
      { name: 'Grep', input: GREP },
    ],
    {
      messages: [
        createUserMessage({ content: 'please do the thing' }),
        ...carried,
        createUserMessage({ content: 'now do it again please' }),
      ],
    },
  )
  check('the second prompt carried the first transcript plus the new user turn', second.calls.length === 3)
  check('the two Greps after the new prompt count from 1: no notice', firstRequestWith(second, ANY_NOTICE) === -1 && reminderYieldIndexes(second).length === 0, `first=${firstRequestWith(second, ANY_NOTICE)}`)
}

section('R4 — the same prompt, no reset: the chain survives across model calls (three Greps after two, in one prompt, fires)')
{
  const run = await runScript([
    { name: 'Grep', input: GREP },
    { name: 'Grep', input: GREP_REORDERED },
    { name: 'Grep', input: GREP },
  ])
  check('property order is ignored: pattern/path and path/pattern are the same call — the notice rides after the 3rd', requestText(run, 3).includes(GENTLE), `request 3: ${requestText(run, 3).slice(-300)}`)
}

section('R5 — a repeated call DENIED by permission still counts: three denied Greps fire the notice after the third')
{
  const run = await runScript(
    [
      { name: 'Grep', input: GREP },
      { name: 'Grep', input: GREP },
      { name: 'Grep', input: GREP },
    ],
    { canUseTool: denyAll },
  )
  check('all three calls were denied (error tool results)', run.ids.every(id => /denied by the rig/.test(toolResultText(run, id))), run.ids.map(id => toolResultText(run, id)).join(' | '))
  check('the notice rides after the 3rd denied result', requestText(run, 3).includes(GENTLE), `request 3: ${requestText(run, 3).slice(-300)}`)
  check('and not after the 1st or 2nd', !ANY_NOTICE.test(requestText(run, 1)) && !ANY_NOTICE.test(requestText(run, 2)))
}

section('R6 — bookkeeping tools are excluded and cannot launder a loop')
{
  const polling = await runScript(Array.from({ length: 5 }, () => ({ name: 'TaskOutput', input: { task_id: 't1' } })))
  check('five identical TaskOutput waits are never a loop: no notice', polling.calls.length === 6 && firstRequestWith(polling, ANY_NOTICE) === -1, `first=${firstRequestWith(polling, ANY_NOTICE)}`)
  const laundered = await runScript([
    { name: 'Grep', input: GREP },
    { name: 'Grep', input: GREP },
    { name: 'TaskOutput', input: { task_id: 't1' } },
    { name: 'Grep', input: GREP },
  ])
  check('a TaskOutput between two Greps does not reset the Grep chain: the notice rides after the third Grep (request 4)', requestText(laundered, 4).includes(GENTLE) && firstRequestWith(laundered, GENTLE) === 4, `first=${firstRequestWith(laundered, GENTLE)}`)
}

section('R7 — a poll is not a loop: ten identical Bash calls whose results differ (a growing log) fire nothing and never end the turn')
{
  const POLL = { command: 'sleep 60; cat build.log', description: 'Wait for the build' }
  const run = await runScript(
    Array.from({ length: 10 }, () => ({ name: 'Bash', input: POLL })),
    { results: (name, input, i) => `${name}:${String(input.command)}\nbuild.log line ${i + 1}` },
  )
  check('eleven model calls: ten polls and the settling text — the turn was never ended', run.calls.length === 11 && run.terminal.reason === 'completed', `calls=${run.calls.length} ${JSON.stringify(run.terminal)}`)
  check('every poll returned a different result', new Set(run.ids.map(id => toolResultText(run, id))).size === 10)
  check('no notice anywhere: an identical call that learned something new is progress', firstRequestWith(run, ANY_NOTICE) === -1 && reminderYieldIndexes(run).length === 0 && noticeRows(run).length === 0, `first=${firstRequestWith(run, ANY_NOTICE)}`)
}

section('R8 — a changed result resets the run: results r1 r1 r2 r2 r2 fire after the 5th call (the 3rd of r2), not after the 3rd')
{
  const run = await runScript(
    Array.from({ length: 5 }, () => ({ name: 'Grep', input: GREP })),
    { results: (_name, _input, i) => (i < 2 ? 'Grep:hits=0' : 'Grep:hits=1') },
  )
  check('the 3rd call (a new result) carries no notice: the run restarted at 1', !ANY_NOTICE.test(requestText(run, 3)))
  check('the 4th call carries no notice (run 2 of the new result)', !ANY_NOTICE.test(requestText(run, 4)))
  check('the gentle sentence rides after the 5th call (run 3 of the new result)', requestText(run, 5).includes(GENTLE) && firstRequestWith(run, GENTLE) === 5, `first=${firstRequestWith(run, GENTLE)}`)
  check('the run completed normally', run.calls.length === 6 && run.terminal.reason === 'completed')
}

section('R9 — inside a sub-agent (agentId set, tool results carry no toolUseResult) the guard fires exactly as on the main thread')
{
  const run = await runScript(
    Array.from({ length: 9 }, () => ({ name: 'Grep', input: GREP })),
    { ctx: { agentId: 'agent-rig-1' } },
  )
  const stripped = run.yields.filter(m => {
    if (m.type !== 'user') return false
    const content = (m as { message?: { content?: unknown } }).message?.content
    return Array.isArray(content) && (m as { toolUseResult?: unknown }).toolUseResult === undefined
  })
  check('the sub-agent shape is real: its nine tool-result frames carry no toolUseResult', stripped.length === 9, `frames without toolUseResult=${stripped.length}`)
  check('a tool-result frame is never a turn boundary: three reminders, at 3, 5 and 8', reminderYieldIndexes(run).length === 3 && firstRequestWith(run, GENTLE) === 3 && requestText(run, 5).includes(NAMED_FIVE) && requestText(run, 8).includes(NAMED_EIGHT), `reminders=${reminderYieldIndexes(run).length} first=${firstRequestWith(run, GENTLE)}`)
  check('the run completed normally', run.calls.length === 10 && run.terminal.reason === 'completed')
}

section('R10 — a tool whose result is empty is still a tool result: three identical calls returning nothing fire after the 3rd')
{
  const run = await runScript(
    Array.from({ length: 3 }, () => ({ name: 'Grep', input: GREP })),
    { results: () => '' },
  )
  check('the notice rides after the 3rd empty result', requestText(run, 3).includes(GENTLE) && firstRequestWith(run, GENTLE) === 3, `first=${firstRequestWith(run, GENTLE)}`)
}

section('R11 — the real Read tool: its unchanged-file stub is the answer "identical", so three Reads of an unchanged file fire after the 3rd, and a changed file resets')
{
  const { mkdirSync, writeFileSync, utimesSync } = await import('node:fs')
  const dir = join(process.env.MERCURY_CONFIG_DIR!, 'read-fixture')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'unchanged.txt')
  writeFileSync(file, 'line one\nline two\n')
  const READ = { file_path: file }
  const real = { ctx: { tools: [FileReadTool, ...TOOLS] } }
  const same = await runScript(Array.from({ length: 3 }, () => ({ name: 'Read', input: READ })), real)
  const second = toolResultText(same, same.ids[1]!)
  check('the second Read answered with the unchanged-file stub (the road the fold is for)', /unchanged since it was last read/.test(second), second.slice(0, 120))
  check('the reminder rides after the 3rd Read and says third', same.calls.length === 4 && requestText(same, 3).includes(GENTLE) && firstRequestWith(same, GENTLE) === 3, `calls=${same.calls.length} first=${firstRequestWith(same, GENTLE)}`)
  let modified = false
  const changed = await runScript(Array.from({ length: 4 }, () => ({ name: 'Read', input: READ })), {
    ...real,
    onYield: (message, yields) => {
      if (modified || message.type !== 'user') return
      const results = yields.filter(m => m.type === 'user' && Array.isArray((m as { message?: { content?: unknown } }).message?.content))
      if (results.length !== 2) return
      modified = true
      writeFileSync(file, 'line one\nline two\nline three\n')
      const later = Math.floor(Date.now() / 1000) + 5
      utimesSync(file, later, later)
    },
  })
  check('the file was modified after the second Read', modified)
  check('Read Read [change] Read Read fires nothing: the third Read learned something new and the fourth is only its second repeat', firstRequestWith(changed, ANY_NOTICE) === -1 && changed.calls.length === 5, `first=${firstRequestWith(changed, ANY_NOTICE)} calls=${changed.calls.length}`)
}

section('R12 — a human message sent mid-turn resets the chain; a task notification does not')
{
  queueStore.resetCommandQueue()
  let sent = false
  const human = await runScript(
    Array.from({ length: 4 }, () => ({ name: 'Grep', input: GREP })),
    {
      onYield: (message, yields) => {
        if (sent || message.type !== 'user') return
        if (yields.filter(m => m.type === 'user').length !== 2) return
        sent = true
        queueStore.enqueue({ value: 'operator words mid turn', mode: 'prompt', uuid: '11111111-2222-4333-8444-666666666661' } as never)
      },
    },
  )
  check('the operator words reached the model after the 2nd result', sent && firstRequestWith(human, 'operator words mid turn') === 2, `first=${firstRequestWith(human, 'operator words mid turn')}`)
  check('the two Greps after the operator spoke count from 1: no notice', firstRequestWith(human, ANY_NOTICE) === -1 && human.calls.length === 5, `first=${firstRequestWith(human, ANY_NOTICE)}`)
  queueStore.resetCommandQueue()
  let notified = false
  const notice = await runScript(
    Array.from({ length: 3 }, () => ({ name: 'Grep', input: GREP })),
    {
      onYield: (message, yields) => {
        if (notified || message.type !== 'user') return
        if (yields.filter(m => m.type === 'user').length !== 2) return
        notified = true
        queueStore.enqueue({ value: 'a background task finished', mode: 'task-notification', uuid: '11111111-2222-4333-8444-666666666662' } as never)
      },
    },
  )
  check('the task notification reached the model after the 2nd result', notified && firstRequestWith(notice, 'a background task finished') === 2, `first=${firstRequestWith(notice, 'a background task finished')}`)
  check('a system notification is not a human turn: the 3rd Grep still fires', requestText(notice, 3).includes(GENTLE), `first=${firstRequestWith(notice, GENTLE)}`)
  queueStore.resetCommandQueue()
}

section('R13 — a repeat counts only across rounds, on the shape every live provider mints (one envelope per block sharing message.id): three identical Greps fired at once count as one; across three rounds they fire at the third')
{
  const oneRound = await runScript([], { rounds: [[{ name: 'Grep', input: GREP }, { name: 'Grep', input: GREP }, { name: 'Grep', input: GREP }]] })
  const envelopes = oneRound.yields.filter(m => m.type === 'assistant' && JSON.stringify((m as { message?: { content?: unknown } }).message?.content).includes('tool_use'))
  const responseIds = new Set(envelopes.map(m => (m as { message?: { id?: string } }).message?.id))
  const uuids = new Set(envelopes.map(m => (m as { uuid?: string }).uuid))
  check('the round is the live shape: three assistant envelopes, three uuids, ONE message.id', envelopes.length === 3 && uuids.size === 3 && responseIds.size === 1, `envelopes=${envelopes.length} uuids=${uuids.size} ids=${responseIds.size}`)
  check('the parallel round ran all three calls (three results) and the turn completed', oneRound.ids.length === 3 && oneRound.ids.every(id => toolResultText(oneRound, id).startsWith('Grep:')) && oneRound.terminal.reason === 'completed')
  check('nothing fires: the model never saw a result and tried the same thing again', firstRequestWith(oneRound, ANY_NOTICE) === -1 && noticeRows(oneRound).length === 0, `first=${firstRequestWith(oneRound, ANY_NOTICE)}`)
  const oneEnvelope = await runScript([], { rounds: [[{ name: 'Grep', input: GREP }, { name: 'Grep', input: GREP }, { name: 'Grep', input: GREP }]], roundShape: 'one-envelope' })
  check('the same three in ONE envelope (a scripted shape) also count as one round', firstRequestWith(oneEnvelope, ANY_NOTICE) === -1 && noticeRows(oneEnvelope).length === 0, `first=${firstRequestWith(oneEnvelope, ANY_NOTICE)}`)
  const threeRounds = await runScript([], { rounds: [[{ name: 'Grep', input: GREP }], [{ name: 'Grep', input: GREP }], [{ name: 'Grep', input: GREP }]] })
  check('the same three across three rounds (three responses, three message.ids) fire at the third', requestText(threeRounds, 3).includes(GENTLE) && firstRequestWith(threeRounds, GENTLE) === 3, `first=${firstRequestWith(threeRounds, GENTLE)}`)
  const twoThenOne = await runScript([], { rounds: [[{ name: 'Grep', input: GREP }, { name: 'Grep', input: GREP }], [{ name: 'Grep', input: GREP }], [{ name: 'Grep', input: GREP }]] })
  check('a parallel pair counts as one round: pair, single, single fires at the third round, not the second', firstRequestWith(twoThenOne, GENTLE) === 3, `first=${firstRequestWith(twoThenOne, GENTLE)}`)
  const twenty = await runScript([], { rounds: [Array.from({ length: 20 }, () => ({ name: 'Grep', input: GREP }))] })
  check('one response of twenty identical parallel blocks is one round: nothing fires, the turn completes', firstRequestWith(twenty, ANY_NOTICE) === -1 && twenty.terminal.reason === 'completed' && twenty.ids.length === 20, `first=${firstRequestWith(twenty, ANY_NOTICE)} ${JSON.stringify(twenty.terminal)}`)
}

console.log('\n' + '='.repeat(76))
if (failures > 0) {
  console.log(`LOOP-GUARD-REMINDER: ${failures} of ${checks} checks FAILED`)
  process.exit(1)
}
console.log(`LOOP-GUARD-REMINDER: all ${checks} checks passed`)
process.exit(0)
