#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

const homeRoot = process.env.MERCURY_CONFIG_DIR ?? tmpdir()
mkdirSync(homeRoot, { recursive: true })
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(homeRoot, 'loop-guard-cycle-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'loop-guard-cycle-daemon-'))
process.env.MERCURY_TEAMS_DIR = mkdtempSync(join(tmpdir(), 'loop-guard-cycle-teams-'))
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
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const settingsRoad = await import('../../src/utils/settings/settings.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
const fs = await import('node:fs')
const { dirname } = await import('node:path')

function setStopKey(value: boolean | null): void {
  const path = settingsRoad.getSettingsFilePathForSource('userSettings')!
  if (value === null) fs.rmSync(path, { force: true })
  else {
    fs.mkdirSync(dirname(path), { recursive: true })
    fs.writeFileSync(path, JSON.stringify({ loopGuardStopEnabled: value }, null, 2))
  }
  resetSettingsCache()
}
function stopKeyReadsBack(): { value: unknown; errors: string[] } {
  const merged = settingsRoad.getSettingsWithErrors()
  return {
    value: (merged.settings as Record<string, unknown>).loopGuardStopEnabled,
    errors: merged.errors.map(e => JSON.stringify(e)),
  }
}

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
  console.log('\nTIMEOUT — loop-guard cycle prover exceeded 120s')
  process.exit(1)
}, 120_000)
watchdog.unref?.()

const NUDGE = 'Loop notice: your last'
const NUDGE_TAIL = 'If the same cycle repeats five more times, the turn will be ended.'
const REPEAT = 'has repeated five more times since the last loop notice'
const ANY_NOTICE = /Loop (check|notice|guard)/
const GREP = { pattern: 'needle', path: '/tmp/haystack' }

type AnyMsg = Record<string, unknown> & { type?: string }
const MODEL = 'claude-opus-4-8'

type ResultScript = (name: string, input: Record<string, unknown>, callIndex: number) => string
const identicalResults: ResultScript = (name, input) =>
  `${name}:${JSON.stringify(Object.fromEntries(Object.entries(input).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))}`
let resultFor: ResultScript = identicalResults
let callIndex = 0

let delayFor: (name: string, callIndex: number) => number = () => 0
function makeTool(name: string, concurrent = false): never {
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
    isConcurrencySafe: () => concurrent,
    isReadOnly: () => true,
    isMcp: false,
    needsPermissions: () => false,
    async validateInput() {
      return { result: true }
    },
    async call(input: Record<string, unknown>) {
      const index = callIndex++
      const wait = delayFor(name, index)
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
      return { data: resultFor(name, input, index) }
    },
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: String(data),
    }),
  } as never
}

const { runToolUse } = await import('../../src/services/tools/toolExecution.ts')
let nestSeq = 0
const nestedAllow = async (_tool: unknown, input: Record<string, unknown>) =>
  ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }) as never
function makeNestTool(): never {
  return {
    name: 'Nest',
    async description() {
      return 'rig tool that runs one nested call through the real transaction'
    },
    async prompt() {
      return 'rig nest'
    },
    inputSchema: z.object({}).catchall(z.unknown()),
    userFacingName: () => 'Nest',
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isMcp: false,
    needsPermissions: () => false,
    async validateInput() {
      return { result: true }
    },
    async call(input: Record<string, unknown>, context: Record<string, unknown>) {
      const inners = (Array.isArray(input.inners) ? input.inners : [input.inner]) as Array<{ name: string; input: Record<string, unknown> }>
      const texts: string[] = []
      for (const inner of inners) {
        const id = `toolu_nest_${++nestSeq}`
        let text = ''
        for await (const update of runToolUse(
          { type: 'tool_use', id, name: inner.name, input: inner.input } as never,
          { uuid: 'nest-parent', requestId: 'nest-req', message: { id: 'nest-msg' } } as never,
          nestedAllow as never,
          context as never,
        )) {
          const content = (update as { message?: { message?: { content?: unknown } } }).message?.message?.content
          if (!Array.isArray(content)) continue
          for (const block of content as Array<{ type?: string; content?: unknown }>) {
            if (block.type === 'tool_result') text = String(block.content)
          }
        }
        texts.push(text)
      }
      const joined = texts.join('|')
      return { data: input.unique === true ? `Nest#${nestSeq}:${joined}` : `Nest:${joined}` }
    },
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: String(data),
    }),
  } as never
}
const TOOLS = [makeTool('Edit'), makeTool('Bash'), makeTool('Read', true), makeTool('Grep', true), makeTool('Glob', true), makeNestTool()]

function makeCtx(agentId?: string): { ctx: Record<string, unknown>; abortController: AbortController } {
  let appState: Record<string, unknown> = {
    ...(getDefaultAppState() as unknown as Record<string, unknown>),
    effortValue: 'high',
  }
  const abortController = new AbortController()
  const ctx: Record<string, unknown> = {
    abortController,
    options: {
      commands: [],
      tools: TOOLS,
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
    agentId,
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

let idSeq = 0
function toolTurn(name: string, input: Record<string, unknown>): { turn: unknown[]; id: string } {
  const id = `tu_${++idSeq}`
  const m = createAssistantMessage({
    content: [{ type: 'tool_use', id, name, input }] as never,
  })
  if (wireId === 'constant') m.message.id = 'msg_fixture'
  else if (wireId === 'empty') m.message.id = ''
  else if (wireId === 'absent') (m.message as { id?: string }).id = undefined as never
  m.message.stop_reason = 'tool_use'
  return { turn: [m], id }
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

type WireId = 'per-response' | 'absent' | 'constant' | 'empty'
let wireId: WireId = 'per-response'
function parallelTurn(calls: Step[]): { turn: unknown[]; ids: string[] } {
  const ids = calls.map(() => `tu_${++idSeq}`)
  const responseId = wireId === 'per-response' ? `msg_round_${idSeq}` : wireId === 'constant' ? 'msg_fixture' : wireId === 'empty' ? '' : undefined
  const envelopes = calls.map((call, i) => {
    const m = createAssistantMessage({
      content: [{ type: 'tool_use', id: ids[i], name: call.name, input: call.input }] as never,
    })
    ;(m.message as { id?: string }).id = responseId as never
    m.message.stop_reason = i === calls.length - 1 ? 'tool_use' : null
    return m
  })
  return { turn: envelopes, ids }
}

async function runScript(steps: Step[], results: ResultScript = identicalResults, agentId?: string, rounds?: Step[][], delays: (name: string, callIndex: number) => number = () => 0): Promise<Run> {
  resultFor = results
  delayFor = delays
  callIndex = 0
  const ids: string[] = []
  const { calls, callModel } = makeModel(i => {
    if (rounds !== undefined) {
      const round = rounds[i]
      if (!round) return textTurn('done')
      const { turn, ids: roundIds } = parallelTurn(round)
      ids.push(...roundIds)
      return turn
    }
    const step = steps[i]
    if (!step) return textTurn('done')
    const { turn, id } = toolTurn(step.name, step.input)
    ids.push(id)
    return turn
  })
  const rig = makeCtx(agentId)
  const gen = query({
    messages: [createUserMessage({ content: 'please do the thing' })] as never,
    systemPrompt: ['rig system prompt'] as never,
    userContext: {},
    systemContext: {},
    canUseTool: allowAll as never,
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
    r = await gen.next()
  }
  return { calls, yields, ids, terminal: r.value }
}

function requestText(run: Run, index: number): string {
  return JSON.stringify(run.calls[index]?.messages ?? [])
}
function firstRequestWith(run: Run, needle: string | RegExp): number {
  for (let i = 0; i < run.calls.length; i++) {
    const text = requestText(run, i)
    if (typeof needle === 'string' ? text.includes(needle) : needle.test(text)) return i
  }
  return -1
}
function toolResultTextOf(run: Run, toolUseId: string): string {
  const at = resultYieldIndex(run, toolUseId)
  const m = run.yields[at] as { message?: { content?: Array<{ content?: unknown }> } } | undefined
  return String(m?.message?.content?.[0]?.content ?? '')
}
function resultYieldIndex(run: Run, toolUseId: string): number {
  return run.yields.findIndex(m => {
    if (m.type !== 'user') return false
    const content = (m as { message?: { content?: unknown } }).message?.content
    return Array.isArray(content) && content.some((b: { type?: string; tool_use_id?: string }) => b.type === 'tool_result' && b.tool_use_id === toolUseId)
  })
}
function attachmentsOf(run: Run, type: string): Array<Record<string, unknown>> {
  return run.yields
    .filter(m => m.type === 'attachment')
    .map(m => (m as { attachment: Record<string, unknown> }).attachment)
    .filter(att => att.type === type)
}
function noticeRows(run: Run): Array<{ level?: string; content?: string }> {
  return run.yields.filter(
    m => m.type === 'system' && ANY_NOTICE.test(String((m as { content?: unknown }).content ?? '')),
  ) as never
}

const EDIT = { file_path: '/tmp/a.ts', old_string: 'x', new_string: 'y' }
const TEST = { command: 'bun test', description: 'Run the tests' }

function pairs(count: number, testInputFor: (i: number) => Record<string, unknown>): Step[] {
  const steps: Step[] = []
  for (let i = 0; i < count; i++) {
    steps.push({ name: 'Edit', input: EDIT })
    steps.push({ name: 'Bash', input: testInputFor(i) })
  }
  return steps
}

setStopKey(null)

section('C1 — DEFAULT (no key): Edit/Bash pairs with identical arguments and answers, ten pairs long: a nudge after the fifth repeat, a stronger reminder after the tenth, the turn never ended')
{
  const run = await runScript(pairs(10, () => TEST))
  check('the key is absent from the merged settings', stopKeyReadsBack().value === undefined, JSON.stringify(stopKeyReadsBack()))
  check('twenty-one model calls: the loop ran to the end of its script and the turn completed on the model\'s own words', run.calls.length === 21 && run.terminal.reason === 'completed', `calls=${run.calls.length} ${JSON.stringify(run.terminal)}`)
  check('nothing fires before the fifth repeat: requests 1..10 carry no notice', Array.from({ length: 10 }, (_, i) => i).every(i => !ANY_NOTICE.test(requestText(run, i))), `first=${firstRequestWith(run, ANY_NOTICE)}`)
  check('the nudge rides in the request after the 10th call (the fifth repeat of the pair) and names the cycle', requestText(run, 10).includes(NUDGE) && firstRequestWith(run, NUDGE) === 10 && /Edit -> Bash/.test(requestText(run, 10)), `first=${firstRequestWith(run, NUDGE)} request 10: ${requestText(run, 10).slice(-500)}`)
  check('with the key off the nudge does not threaten a turn end', !requestText(run, 10).includes(NUDGE_TAIL))
  check('the second detection (after the 20th call) is a stronger reminder, not a stop', requestText(run, 20).includes(REPEAT) && /2 detections this turn/.test(requestText(run, 20)), `request 20: ${requestText(run, 20).slice(-500)}`)
  check('no loop_stopped attachment was yielded', attachmentsOf(run, 'loop_stopped').length === 0)
  const rows = noticeRows(run)
  check('the operator gets two info rows, the second saying the turn continues and naming the key', rows.length === 2 && rows.every(r => r.level === 'info') && /turn continues \(loopGuardStopEnabled is off\)/.test(String(rows[1]?.content)), JSON.stringify(rows.map(r => [r.level, r.content])))
  check('every one of the twenty calls ran (nothing blocked)', run.ids.length === 20)
}

section('C2 — Edit/Bash pairs where the Bash arguments change each time: nothing fires, the loop runs to the end')
{
  const run = await runScript(pairs(10, i => ({ command: `bun test --seed ${i}`, description: 'Run the tests' })))
  check('the model was called twenty-one times (twenty tool rounds and the settling text)', run.calls.length === 21, `calls=${run.calls.length}`)
  check('the turn completed normally', run.terminal.reason === 'completed', JSON.stringify(run.terminal))
  check('no notice anywhere', firstRequestWith(run, ANY_NOTICE) === -1 && noticeRows(run).length === 0, `first=${firstRequestWith(run, ANY_NOTICE)}`)
}

section('C3 — a three-call cycle (Read/Edit/Bash) repeated five times is caught at the fifteenth call')
{
  const steps: Step[] = []
  for (let i = 0; i < 5; i++) {
    steps.push({ name: 'Read', input: { file_path: '/tmp/a.ts' } })
    steps.push({ name: 'Edit', input: EDIT })
    steps.push({ name: 'Bash', input: TEST })
  }
  const run = await runScript(steps)
  check('sixteen model calls, the turn completed (one nudge, no stop)', run.calls.length === 16 && run.terminal.reason === 'completed', `calls=${run.calls.length} ${JSON.stringify(run.terminal)}`)
  check('the nudge rides after the 15th call and names the three-call cycle', firstRequestWith(run, NUDGE) === 15 && /Read -> Edit -> Bash/.test(requestText(run, 15)), `first=${firstRequestWith(run, NUDGE)}`)
}

section('C4 — the ring is bounded: a cycle that needs more than the last 25 calls is not judged (six-call cycle, five repeats)')
{
  const steps: Step[] = []
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 6; j++) steps.push({ name: 'Read', input: { file_path: `/tmp/f${j}.ts` } })
  }
  const run = await runScript(steps)
  check('thirty-one model calls, no notice: cycles longer than five are outside the detector', run.calls.length === 31 && firstRequestWith(run, ANY_NOTICE) === -1, `calls=${run.calls.length} first=${firstRequestWith(run, ANY_NOTICE)}`)
}

section('C5 — a poll is not a loop: ten identical Bash calls whose results differ (a growing log) fire nothing')
{
  const POLL = { command: 'sleep 60; cat build.log', description: 'Wait for the build' }
  const run = await runScript(
    Array.from({ length: 10 }, () => ({ name: 'Bash', input: POLL })),
    (name, input, i) => `${name}:${String(input.command)}\nbuild.log line ${i + 1}`,
  )
  check('eleven model calls and a completed turn', run.calls.length === 11 && run.terminal.reason === 'completed', `calls=${run.calls.length} ${JSON.stringify(run.terminal)}`)
  check('no nudge, no stop, no row: an identical call that learned something new is progress', firstRequestWith(run, ANY_NOTICE) === -1 && attachmentsOf(run, 'loop_stopped').length === 0 && noticeRows(run).length === 0, `first=${firstRequestWith(run, ANY_NOTICE)}`)
}

section('C6 — Edit/Bash pairs, ten long, where the test output changes each time: nothing fires, the loop runs to the end')
{
  const run = await runScript(
    pairs(10, () => TEST),
    (name, input, i) => (name === 'Bash' ? `Bash:${String(input.command)}\nfailures: ${10 - Math.floor(i / 2)}` : identicalResults(name, input, i)),
  )
  check('twenty-one model calls, the turn completed', run.calls.length === 21 && run.terminal.reason === 'completed', `calls=${run.calls.length} ${JSON.stringify(run.terminal)}`)
  check('no notice anywhere: the cycle carries new information every time round', firstRequestWith(run, ANY_NOTICE) === -1 && noticeRows(run).length === 0, `first=${firstRequestWith(run, ANY_NOTICE)}`)
}

section('C7 — DEFAULT, inside a sub-agent (agentId set, tool results carry no toolUseResult): the detector behaves exactly as on the main thread')
{
  const run = await runScript(pairs(10, () => TEST), identicalResults, 'agent-rig-2')
  const stripped = run.yields.filter(m => {
    if (m.type !== 'user') return false
    const content = (m as { message?: { content?: unknown } }).message?.content
    return Array.isArray(content) && (m as { toolUseResult?: unknown }).toolUseResult === undefined
  })
  check('the sub-agent shape is real: its tool-result frames carry no toolUseResult', stripped.length === 20, `frames without toolUseResult=${stripped.length}`)
  check('the nudge rides after the 10th call and the stronger reminder after the 20th, the turn completed', firstRequestWith(run, NUDGE) === 10 && requestText(run, 20).includes(REPEAT) && run.calls.length === 21 && run.terminal.reason === 'completed', `first=${firstRequestWith(run, NUDGE)} calls=${run.calls.length} ${JSON.stringify(run.terminal)}`)
}

section('C8 — DEFAULT: a run of ONE identical call with identical results stays advisory forever (twenty identical Greps: reminders, never an end)')
{
  const run = await runScript(Array.from({ length: 20 }, () => ({ name: 'Grep', input: GREP })))
  check('twenty-one model calls, the turn completed on the model\'s own words', run.calls.length === 21 && run.terminal.reason === 'completed', `calls=${run.calls.length} ${JSON.stringify(run.terminal)}`)
  const after: number[] = []
  let settled = 0
  for (const m of run.yields) {
    if (m.type === 'user' && Array.isArray((m as { message?: { content?: unknown } }).message?.content)) settled++
    if (m.type === 'attachment' && (m as { attachment?: { type?: string; content?: unknown } }).attachment?.type === 'critical_system_reminder') after.push(settled)
  }
  check('reminders rode after the 3rd, 5th, 8th, 10th, 15th and 20th calls and nowhere else', JSON.stringify(after) === JSON.stringify([3, 5, 8, 10, 15, 20]), `after=${JSON.stringify(after)}`)
  check('the 10th, 15th and 20th carry the length-one text with the run length', /has returned the same result 10 times/.test(requestText(run, 10)) && /has returned the same result 15 times/.test(requestText(run, 15)) && /has returned the same result 20 times/.test(requestText(run, 20)))
  check('no loop_stopped attachment, no warning row', attachmentsOf(run, 'loop_stopped').length === 0 && noticeRows(run).every(r => r.level === 'info'))
}

setStopKey(true)

section('C9 — KEY ON (loopGuardStopEnabled: true in the scratch home\'s settings.json): the second detection of the SAME cycle ends the turn with loop_stopped naming that cycle')
{
  const read = stopKeyReadsBack()
  check('the key reads back true through the ordinary settings road (a settings-file change hot-applies)', read.value === true, JSON.stringify(read))
  const { SettingsSchema } = await import('../../src/utils/settings/types.ts')
  const declared = Object.prototype.hasOwnProperty.call((SettingsSchema() as { shape: Record<string, unknown> }).shape, 'loopGuardStopEnabled')
  check('the key is DECLARED in the settings schema, not merely carried through as an unknown key nothing reads', declared, `schema keys with "loop": ${Object.keys((SettingsSchema() as { shape: Record<string, unknown> }).shape).filter(k => /loop/i.test(k)).join(',') || '(none — the passthrough schema carries the key silently and nothing reads it)'}`)
  const run = await runScript(pairs(10, () => TEST))
  check('the loop did NOT run to the end of the script: the model was called twenty times, never a twenty-first', run.calls.length === 20, `calls=${run.calls.length}`)
  check('the turn ended typed as loop_stopped, carrying the cycle', run.terminal.reason === 'loop_stopped' && JSON.stringify((run.terminal as { cycle?: unknown }).cycle) === JSON.stringify(['Edit', 'Bash']), JSON.stringify(run.terminal))
  check('the nudge after the 10th call now warns that a repeat ends the turn', requestText(run, 10).includes(NUDGE) && requestText(run, 10).includes(NUDGE_TAIL), `request 10: ${requestText(run, 10).slice(-400)}`)
  const stops = attachmentsOf(run, 'loop_stopped')
  check('one loop_stopped attachment was yielded, naming the cycle that fired', stops.length === 1 && JSON.stringify(stops[0]?.cycle) === JSON.stringify(['Edit', 'Bash']) && /the same cycle of tool calls \(Edit -> Bash\)/.test(String(stops[0]?.message)), JSON.stringify(stops))
  const rows = noticeRows(run)
  check('the operator gets an info row for the nudge and a warning row for the end that names the key', rows.length === 2 && rows[0]?.level === 'info' && rows[1]?.level === 'warning' && /ended the turn/.test(String(rows[1]?.content)) && /loopGuardStopEnabled/.test(String(rows[1]?.content)), JSON.stringify(rows.map(r => [r.level, r.content])))
  check('every one of the twenty calls ran (nothing blocked before the end)', run.ids.length === 20)
}

section('C10 — KEY ON: two different cycles, each detected once, end nothing (the second detection must be of the SAME loop)')
{
  const TEST_B = { command: 'bun test --filter b', description: 'Run the b tests' }
  const steps = [...pairs(5, () => TEST), ...pairs(5, () => TEST_B)]
  const run = await runScript(steps)
  check('twenty-one model calls, the turn completed', run.calls.length === 21 && run.terminal.reason === 'completed', `calls=${run.calls.length} ${JSON.stringify(run.terminal)}`)
  check('two first-detection nudges rode (after the 10th and the 20th calls), no stop', firstRequestWith(run, NUDGE) === 10 && requestText(run, 20).includes(NUDGE) && !requestText(run, 20).includes(REPEAT) && attachmentsOf(run, 'loop_stopped').length === 0, `first=${firstRequestWith(run, NUDGE)}`)
}

section('C11 — KEY ON: a run of ONE identical call never ends the turn (twenty identical Greps), and two different single runs end nothing')
{
  const run = await runScript(Array.from({ length: 20 }, () => ({ name: 'Grep', input: GREP })))
  check('twenty-one model calls, the turn completed, no loop_stopped', run.calls.length === 21 && run.terminal.reason === 'completed' && attachmentsOf(run, 'loop_stopped').length === 0, `calls=${run.calls.length} ${JSON.stringify(run.terminal)}`)
  const mixed = await runScript([
    ...Array.from({ length: 5 }, () => ({ name: 'Grep', input: { pattern: 'TODO', path: '/tmp' } })),
    { name: 'Read', input: { file_path: '/tmp/other' } },
    ...Array.from({ length: 5 }, () => ({ name: 'Grep', input: { pattern: 'FIXME', path: '/tmp' } })),
  ])
  check('Grep(TODO) x5, Read, Grep(FIXME) x5: two single detections of different calls, the turn completed', mixed.calls.length === 12 && mixed.terminal.reason === 'completed' && attachmentsOf(mixed, 'loop_stopped').length === 0, `calls=${mixed.calls.length} ${JSON.stringify(mixed.terminal)}`)
}

section('C12 — KEY ON: a repeat counts only across rounds, on the live shape (one envelope per block sharing message.id): ten parallel rounds of [Edit, Bash] nudge at round 5 and end at round 10')
{
  const run = await runScript([], identicalResults, undefined, Array.from({ length: 10 }, () => [{ name: 'Edit', input: EDIT }, { name: 'Bash', input: TEST }]))
  check('ten parallel rounds of the identical pair: the nudge after round 5, the end after round 10, the cycle named in issue order', firstRequestWith(run, NUDGE) === 5 && run.calls.length === 10 && run.terminal.reason === 'loop_stopped' && JSON.stringify((run.terminal as { cycle?: unknown }).cycle) === JSON.stringify(['Edit', 'Bash']), `first=${firstRequestWith(run, NUDGE)} calls=${run.calls.length} ${JSON.stringify(run.terminal)}`)
  const twenty = await runScript([], identicalResults, undefined, [Array.from({ length: 10 }, () => [{ name: 'Edit', input: EDIT }, { name: 'Bash', input: TEST }]).flat()])
  check('one response of twenty parallel blocks [Edit, Bash] x10 is ONE round: nothing fires, the turn is never ended before the model saw a result', firstRequestWith(twenty, ANY_NOTICE) === -1 && twenty.terminal.reason === 'completed' && twenty.calls.length === 2, `first=${firstRequestWith(twenty, ANY_NOTICE)} calls=${twenty.calls.length} ${JSON.stringify(twenty.terminal)}`)
  const flipping = await runScript(
    [],
    identicalResults,
    undefined,
    Array.from({ length: 10 }, () => [{ name: 'Grep', input: GREP }, { name: 'Glob', input: { pattern: '*.md', path: '/tmp' } }]),
    (name, index) => (Math.floor(index / 2) % 2 === 0 ? (name === 'Grep' ? 25 : 0) : name === 'Grep' ? 0 : 25),
  )
  const settledOrder = flipping.ids.map(id => resultYieldIndex(flipping, id))
  const flipped = settledOrder.some((at, i) => i % 2 === 0 && settledOrder[i + 1] !== undefined && settledOrder[i + 1]! < at)
  check('the concurrent pair really settled in varying order across rounds', flipped, `order=${JSON.stringify(settledOrder)}`)
  check('the cycle is still caught at round 5 and ended at round 10, named in the order the model issued the calls (Grep -> Glob), whatever order they settled in', firstRequestWith(flipping, NUDGE) === 5 && /Grep -> Glob/.test(requestText(flipping, 5)) && flipping.calls.length === 10 && flipping.terminal.reason === 'loop_stopped' && JSON.stringify((flipping.terminal as { cycle?: unknown }).cycle) === JSON.stringify(['Grep', 'Glob']), `first=${firstRequestWith(flipping, NUDGE)} calls=${flipping.calls.length} ${JSON.stringify(flipping.terminal)}`)
}

section('C14 — KEY ON: a sub-agent the guard ends settles to its parent as a typed failure naming the cycle, never as a completed report')
{
  const { finalizeAgentTool } = await import('../../src/tools/AgentTool/agentToolUtils.ts')
  const { AgentTool } = await import('../../src/tools/AgentTool/AgentTool.tsx')
  const run = await runScript(pairs(10, () => TEST), identicalResults, 'agent-rig-3')
  const collected = run.yields.filter(m => m.type === 'assistant' || m.type === 'user' || m.type === 'attachment')
  const finalized = finalizeAgentTool(collected as never, 'agent-rig-3', { prompt: 'loop', resolvedAgentModel: MODEL, isBuiltInAgent: true, startTime: Date.now(), agentType: 'general-purpose', isAsync: false })
  check('the finalized outcome is a typed failure with the loop-stopped reason and the stop text naming the cycle', finalized.outcome?.status === 'failed' && (finalized.outcome as { reason?: string }).reason === 'loop-stopped' && /the same cycle of tool calls \(Edit -> Bash\)/.test(String((finalized.outcome as { error?: string }).error)), JSON.stringify(finalized.outcome))
  const block = AgentTool.mapToolResultToToolResultBlockParam({ status: 'failed', prompt: 'loop', error: (finalized.outcome as { error?: string }).error, ...finalized } as never, 'tu_parent') as { is_error?: boolean; content?: Array<{ text?: string }> }
  const parentText = (block.content ?? []).map(b => b.text ?? '').join('\n')
  check('the parent receives is_error with "Agent execution failed: The loop guard ended the turn"', block.is_error === true && /Agent execution failed: The loop guard ended the turn/.test(parentText), parentText.slice(0, 300))
}

section('C15 — KEY ON: the round is judged only when it is complete, in issue order, whatever order the calls settle in — a cycle boundary inside a parallel response never decides by timing')
{
  const ALT: Step[] = []
  for (let i = 0; i < 19; i++) ALT.push(i % 2 === 0 ? { name: 'Grep', input: GREP } : { name: 'Glob', input: { pattern: '*.md', path: '/tmp' } })
  const serialRounds = ALT.map(step => [step])
  const foreign = (first: 'Read' | 'Glob'): Array<Step[]> => [...serialRounds, [{ name: 'Read', input: { file_path: '/tmp/z.ts' } }, { name: 'Glob', input: { pattern: '*.md', path: '/tmp' } }]]
  for (const settlesFirst of ['Glob', 'Read'] as const) {
    const run = await runScript([], identicalResults, undefined, foreign(settlesFirst), (name, index) => (index >= 19 ? (name === settlesFirst ? 0 : 30) : 0))
    const lastTwo = run.ids.slice(-2).map(id => resultYieldIndex(run, id))
    const order = settlesFirst === 'Glob' ? lastTwo[1]! < lastTwo[0]! : lastTwo[0]! < lastTwo[1]!
    check(`19 alternating then [Read z, Glob b] with ${settlesFirst} settling first: the settle order was forced as intended`, order, `order=${JSON.stringify(lastTwo)}`)
    check(`…and the round with a call outside the cycle breaks the cycle: no stop, the turn completes (${settlesFirst} first)`, run.terminal.reason === 'completed' && attachmentsOf(run, 'loop_stopped').length === 0 && run.calls.length === 21, `calls=${run.calls.length} ${JSON.stringify(run.terminal)}`)
  }
  const continuation = (): Array<Step[]> => [...serialRounds, [{ name: 'Glob', input: { pattern: '*.md', path: '/tmp' } }, { name: 'Grep', input: GREP }]]
  for (const settlesFirst of ['Grep', 'Glob'] as const) {
    const run = await runScript([], identicalResults, undefined, continuation(), (name, index) => (index >= 19 ? (name === settlesFirst ? 0 : 30) : 0))
    check(`19 alternating then the continuation [Glob b, Grep a] with ${settlesFirst} settling first: the second detection lands and the turn ends loop_stopped naming Grep -> Glob`, run.terminal.reason === 'loop_stopped' && JSON.stringify((run.terminal as { cycle?: unknown }).cycle) === JSON.stringify(['Grep', 'Glob']) && run.calls.length === 20, `calls=${run.calls.length} ${JSON.stringify(run.terminal)}`)
  }
  const broken = await runScript([], identicalResults, undefined, [...serialRounds, [{ name: 'Grep', input: GREP }, { name: 'Glob', input: { pattern: '*.md', path: '/tmp' } }]], (name, index) => (index >= 19 && name === 'Glob' ? 0 : index >= 19 ? 30 : 0))
  check('19 alternating (ending Grep) then [Grep a, Glob b] is a BROKEN alternation in issue order (Grep twice), so it does not stop even though Glob settles first', broken.terminal.reason === 'completed' && attachmentsOf(broken, 'loop_stopped').length === 0, `calls=${broken.calls.length} ${JSON.stringify(broken.terminal)}`)
}

section('C16 — DEFAULT: the same law for the first detection — a parallel round carrying a foreign call never completes a cycle, whichever order it settles in')
{
  setStopKey(null)
  const NINE: Step[] = []
  for (let i = 0; i < 9; i++) NINE.push(i % 2 === 0 ? { name: 'Grep', input: GREP } : { name: 'Glob', input: { pattern: '*.md', path: '/tmp' } })
  const nineRounds = NINE.map(step => [step])
  for (const shape of [['Read', 'Glob'], ['Glob', 'Read']] as const) {
    for (const settlesFirst of ['Glob', 'Read'] as const) {
      const rounds: Array<Step[]> = [...nineRounds, shape.map(name => (name === 'Read' ? { name: 'Read', input: { file_path: '/tmp/z.ts' } } : { name: 'Glob', input: { pattern: '*.md', path: '/tmp' } }))]
      const run = await runScript([], identicalResults, undefined, rounds, (name, index) => (index >= 9 ? (name === settlesFirst ? 0 : 30) : 0))
      check(`(Grep,Glob)x4 + Grep, then [${shape.join(', ')}] with ${settlesFirst} settling first: no nudge either way`, firstRequestWith(run, NUDGE) === -1 && run.terminal.reason === 'completed', `first=${firstRequestWith(run, NUDGE)}`)
    }
  }
  const clean = await runScript([], identicalResults, undefined, [...nineRounds, [{ name: 'Glob', input: { pattern: '*.md', path: '/tmp' } }]])
  check('control: the plain continuation [Glob] nudges after the 10th call', firstRequestWith(clean, NUDGE) === 10, `first=${firstRequestWith(clean, NUDGE)}`)
  setStopKey(true)
}

section('C17 — the round is Mercury\'s own, never the wire\'s message id: an absent, constant or empty message.id changes nothing')
{
  for (const shape of ['absent', 'constant', 'empty'] as const) {
    wireId = shape
    const parallel = await runScript([], identicalResults, undefined, [[{ name: 'Grep', input: GREP }, { name: 'Grep', input: GREP }, { name: 'Grep', input: GREP }]])
    check(`message.id ${shape}: three identical parallel Greps in one response fire nothing`, firstRequestWith(parallel, ANY_NOTICE) === -1 && parallel.terminal.reason === 'completed', `first=${firstRequestWith(parallel, ANY_NOTICE)}`)
    const serial = await runScript(Array.from({ length: 10 }, () => ({ name: 'Grep', input: GREP })))
    const reminders = serial.yields.filter(m => m.type === 'attachment' && (m as { attachment?: { type?: string } }).attachment?.type === 'critical_system_reminder').length
    check(`message.id ${shape}: ten identical Greps over ten responses draw the reminders at 3, 5, 8 and the length-one detection at 10 (never silent)`, reminders === 4 && firstRequestWith(serial, ANY_NOTICE) === 3, `reminders=${reminders} first=${firstRequestWith(serial, ANY_NOTICE)}`)
    const twenty = await runScript([], identicalResults, undefined, [Array.from({ length: 10 }, () => [{ name: 'Edit', input: EDIT }, { name: 'Bash', input: TEST }]).flat()])
    check(`message.id ${shape}, key on: one response of twenty parallel blocks is one round — the turn is not ended`, twenty.terminal.reason === 'completed' && twenty.calls.length === 2, `calls=${twenty.calls.length} ${JSON.stringify(twenty.terminal)}`)
    const pairsRun = await runScript(pairs(12, () => TEST))
    check(`message.id ${shape}, key on: twelve serial pairs end the turn loop_stopped at the 20th call`, pairsRun.terminal.reason === 'loop_stopped' && pairsRun.calls.length === 20, `calls=${pairsRun.calls.length} ${JSON.stringify(pairsRun.terminal)}`)
  }
  wireId = 'per-response'
}

section('C18 — a nested call (a tool that runs runToolUse inside its own execution, the Workshop\'s shape) JOINS the response\'s open round: the earlier calls of the response are kept, and no detection is ever counted that the model never saw')
{
  const GLOB = { pattern: '*.md', path: '/tmp' }
  const NINE: Step[] = []
  for (let i = 0; i < 9; i++) NINE.push(i % 2 === 0 ? { name: 'Grep', input: GREP } : { name: 'Glob', input: GLOB })
  const nineRounds = NINE.map(step => [step])
  const bundled = (): Array<Step[]> => [
    ...nineRounds,
    [{ name: 'Read', input: { file_path: '/tmp/z.ts' } }, { name: 'Nest', input: { unique: true, inner: { name: 'Glob', input: GLOB } } }],
    ...Array.from({ length: 12 }, (_, i) => [i % 2 === 0 ? { name: 'Grep', input: GREP } : { name: 'Glob', input: GLOB }]),
  ]
  const serial = (): Array<Step[]> => [
    ...nineRounds,
    [{ name: 'Read', input: { file_path: '/tmp/z.ts' } }],
    [{ name: 'Nest', input: { unique: true, inner: { name: 'Glob', input: GLOB } } }],
    ...Array.from({ length: 12 }, (_, i) => [i % 2 === 0 ? { name: 'Grep', input: GREP } : { name: 'Glob', input: GLOB }]),
  ]
  const nestResult: ResultScript = (name, input, i) => (name === 'Nest' ? `Nest:${i}` : identicalResults(name, input, i))
  const noticeRequests = (run: Run): number[] => {
    const out: number[] = []
    let settled = 0
    for (const m of run.yields) {
      if (m.type === 'user' && Array.isArray((m as { message?: { content?: unknown } }).message?.content)) settled++
      if (m.type === 'attachment' && (m as { attachment?: { type?: string } }).attachment?.type === 'critical_system_reminder') out.push(settled)
    }
    return out
  }
  setStopKey(true)
  const tip = await runScript([], nestResult, undefined, bundled())
  const nestOk = tip.ids.some(id => /^Nest#\d+:Glob:/.test(toolResultTextOf(tip, id)))
  check('the nested Glob really ran through the transaction inside Nest (its result is inside Nest\'s)', nestOk, tip.ids.map(id => toolResultTextOf(tip, id)).filter(t => t.startsWith('Nest')).join(' | '))
  check('KEY ON, [Read /z, Nest(Glob)] after nine alternating calls: no stop — the response is judged whole, with Read in it, so the cycle is broken', tip.terminal.reason === 'completed' && attachmentsOf(tip, 'loop_stopped').length === 0, `calls=${tip.calls.length} ${JSON.stringify(tip.terminal)} rows=${JSON.stringify(noticeRows(tip).map(r => r.content))}`)
  check('…and the first notice the model receives is the first detection (after the tenth fresh call), never a stop claiming an earlier notice', noticeRequests(tip).length >= 1 && noticeRows(tip).every(r => r.level === 'info') && !noticeRows(tip).some(r => /ended the turn/.test(String(r.content))), `notices after calls ${JSON.stringify(noticeRequests(tip))} rows=${JSON.stringify(noticeRows(tip).map(r => r.content))}`)
  const control = await runScript([], nestResult, undefined, serial())
  check('control, one call per response ([Read /z], [Nest(Glob)]): the same outcome — completed, the notice after the same settled count (the nested result is consumed inside Nest, never a turn-level result)', control.terminal.reason === 'completed' && attachmentsOf(control, 'loop_stopped').length === 0 && JSON.stringify(noticeRequests(control)) === JSON.stringify(noticeRequests(tip)), `tip=${JSON.stringify(noticeRequests(tip))} control=${JSON.stringify(noticeRequests(control))}`)
  setStopKey(null)
  const dflt = await runScript([], nestResult, undefined, bundled())
  check('DEFAULT, the same bundled shape: completed, no stop, the notice reaches the model', dflt.terminal.reason === 'completed' && attachmentsOf(dflt, 'loop_stopped').length === 0 && noticeRequests(dflt).length >= 1, `calls=${dflt.calls.length} notices=${JSON.stringify(noticeRequests(dflt))}`)
  const nestOnly = await runScript([], identicalResults, undefined, Array.from({ length: 5 }, () => [{ name: 'Nest', input: { inner: { name: 'Grep', input: GREP } } }]))
  check('a nested call is recorded in its parent\'s round: five Nest(Grep a) responses with identical results are the two-call cycle Grep -> Nest, nudged after the fifth and seen by the model', noticeRequests(nestOnly).length === 1 && noticeRequests(nestOnly)[0] === 5 && /Grep -> Nest/.test(requestText(nestOnly, 5)), `notices=${JSON.stringify(noticeRequests(nestOnly))} request5=${requestText(nestOnly, 5).slice(-300)}`)
}

section('C19 — nested calls keep the model\'s issue order at any depth and any count: a round is ordered by the top-level call, then by the order the calls were recorded')
{
  const GLOB = { pattern: '*.md', path: '/tmp' }
  const glob = { name: 'Glob', input: GLOB }
  const read = (path: string): Step => ({ name: 'Read', input: { file_path: path } })
  const nest = (...inners: Step[]): Step => ({ name: 'Nest', input: { unique: true, inners } })
  const remindersOf = (run: Run): string[] => run.yields.filter(m => m.type === 'attachment' && (m as { attachment?: { type?: string } }).attachment?.type === 'critical_system_reminder').map(m => String((m as { attachment: { content?: unknown } }).attachment.content))
  setStopKey(null)
  const depthTwo = await runScript([], identicalResults, undefined, [[glob], [glob], [nest(read('/tmp/z.ts'), nest(glob))]])
  check('depth 2 with an earlier call in the cell — [Glob n] x2 then [Nest(Read /z, Nest(Glob n))]: the cell\'s Read comes before its Glob, so Glob\'s run is broken and nothing fires', remindersOf(depthTwo).length === 0 && noticeRows(depthTwo).length === 0, `reminders=${JSON.stringify(remindersOf(depthTwo))} rows=${JSON.stringify(noticeRows(depthTwo).map(r => r.content))}`)
  const depthTwoSerial = await runScript([], identicalResults, undefined, [[glob], [glob], [nest(read('/tmp/z.ts'))], [nest(nest(glob))]])
  check('control: the same calls one per response fire nothing', remindersOf(depthTwoSerial).length === 0, JSON.stringify(remindersOf(depthTwoSerial)))
  const depthThree = await runScript([], identicalResults, undefined, [[glob], [glob], [read('/tmp/z.ts'), nest(nest(nest(glob)))]])
  check('depth 3 — [Read /z, Nest(Nest(Nest(Glob n)))] after [Glob n] x2: the Read is before the Glob however deep the Glob sits, nothing fires', remindersOf(depthThree).length === 0 && noticeRows(depthThree).length === 0, `reminders=${JSON.stringify(remindersOf(depthThree))}`)
  const depthThreeAlone = await runScript([], identicalResults, undefined, [[glob], [glob], [nest(nest(nest(glob)))]])
  check('depth 3 without a sibling — [Nest(Nest(Nest(Glob n)))] after [Glob n] x2 IS the third identical Glob: the reminder rides', remindersOf(depthThreeAlone).length === 1 && /third identical tool call/.test(remindersOf(depthThreeAlone)[0] ?? ''), JSON.stringify(remindersOf(depthThreeAlone)))
  const manyReads = Array.from({ length: 501 }, (_, i) => read(`/tmp/r${i}.ts`))
  const bigParent = await runScript([], identicalResults, undefined, [[nest(...manyReads, glob)], [glob], [glob], [glob]])
  const afterCalls = (run: Run): number[] => {
    const out: number[] = []
    let settled = 0
    for (const m of run.yields) {
      if (m.type === 'user' && Array.isArray((m as { message?: { content?: unknown } }).message?.content)) settled++
      if (m.type === 'attachment' && (m as { attachment?: { type?: string } }).attachment?.type === 'critical_system_reminder') out.push(settled)
    }
    return out
  }
  check('a parent with 501 nested Reads then a Glob, followed by [Glob n] x3: the nested Glob stays before its parent (the parent\'s own fresh result breaks the run), so the third identical Glob is the fourth top-level result — the reminder rides there, never a response early', JSON.stringify(afterCalls(bigParent)) === JSON.stringify([4]) && /third identical tool call/.test(remindersOf(bigParent)[0] ?? ''), `after=${JSON.stringify(afterCalls(bigParent))} reminders=${remindersOf(bigParent).length}`)
  const tenReads = Array.from({ length: 10 }, (_, i) => read(`/tmp/r${i}.ts`))
  const smallParent = await runScript([], identicalResults, undefined, [[nest(...tenReads, glob)], [glob], [glob], [glob]])
  check('control: the same shape with 10 nested Reads reminds at the same place', JSON.stringify(afterCalls(smallParent)) === JSON.stringify(afterCalls(bigParent)), `small=${JSON.stringify(afterCalls(smallParent))} big=${JSON.stringify(afterCalls(bigParent))}`)
}

setStopKey(null)
section('C13 — the key removed again: the same loop is back to reminders only')
{
  check('the key no longer reads back', stopKeyReadsBack().value === undefined)
  const run = await runScript(pairs(10, () => TEST))
  check('twenty-one model calls, completed, no loop_stopped', run.calls.length === 21 && run.terminal.reason === 'completed' && attachmentsOf(run, 'loop_stopped').length === 0, `calls=${run.calls.length} ${JSON.stringify(run.terminal)}`)
}

console.log('\n' + '='.repeat(76))
if (failures > 0) {
  console.log(`LOOP-GUARD-CYCLE: ${failures} of ${checks} checks FAILED`)
  process.exit(1)
}
console.log(`LOOP-GUARD-CYCLE: all ${checks} checks passed`)
process.exit(0)
