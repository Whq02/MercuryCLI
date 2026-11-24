#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

const homeRoot = process.env.MERCURY_CONFIG_DIR ?? tmpdir()
mkdirSync(homeRoot, { recursive: true })
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(homeRoot, 'early-tool-start-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'early-tool-start-daemon-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
for (const k of ['MERCURY_BARE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_SCRIPTED_STREAM', 'NODE_ENV']) {
  delete process.env[k]
}

const { turnDoor } = await import('../../src/engine/turnDoor.ts')
const bootstrap = await import('../../src/boot/process-state/processState.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/engine/message-shapes/factories.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.ts')

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
  console.log('\nTIMEOUT — early-tool-start prover exceeded 180s; a scripted stream or an early call never settled, look at EarlyStarts in src/engine/tool-dispatch/earlyStarts.ts and the section whose marks printed last')
  process.exit(1)
}, 180_000)
watchdog.unref?.()

type AnyMsg = Record<string, unknown> & { type?: string }
const MODEL = 'claude-opus-4-8'
const STREAM_CEILING_MS = 3_000

const marks: string[] = []
const startWaiters = new Map<string, () => void>()
function whenStarted(toolUseId: string): Promise<void> {
  return new Promise(resolve => {
    startWaiters.set(toolUseId, resolve)
  })
}
let safeTools = true
let callDelayMs = 0
type Shape = { name: string; readOnly: boolean; safeWhenOn: boolean; pathOf: (input: Record<string, unknown>) => string | undefined }
function makeTool(shape: Shape): never {
  return {
    name: shape.name,
    async description() {
      return 'rig tool'
    },
    async prompt() {
      return 'rig tool'
    },
    inputSchema: z.object({}).catchall(z.unknown()),
    userFacingName: () => shape.name,
    isEnabled: () => true,
    isConcurrencySafe: () => safeTools && shape.safeWhenOn,
    isReadOnly: () => shape.readOnly,
    getPath: (input: Record<string, unknown>) => shape.pathOf(input),
    isMcp: false,
    maxResultSizeChars: 50_000,
    needsPermissions: () => false,
    async validateInput() {
      return { result: true }
    },
    async call(input: Record<string, unknown>, context: { toolUseId?: string; abortController: AbortController }) {
      const id = context.toolUseId ?? '?'
      marks.push(`tool:start:${shape.name}:${id}`)
      startWaiters.get(id)?.()
      if (callDelayMs > 0) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, callDelayMs)
          context.abortController.signal.addEventListener('abort', () => {
            clearTimeout(timer)
            resolve()
          }, { once: true })
        })
      }
      if (context.abortController.signal.aborted) marks.push(`tool:aborted:${shape.name}:${id}`)
      marks.push(`tool:end:${shape.name}:${id}`)
      return { data: `${shape.name} answered ${JSON.stringify(input)}` }
    },
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({ type: 'tool_result', tool_use_id: toolUseId, content: String(data) }),
  } as never
}
const filePathOf = (input: Record<string, unknown>) => (typeof input.file_path === 'string' ? input.file_path : undefined)
const TOOLS = [
  makeTool({ name: 'Grep', readOnly: true, safeWhenOn: true, pathOf: input => (typeof input.path === 'string' ? input.path : '/tmp/early-start-tree') }),
  makeTool({ name: 'Read', readOnly: true, safeWhenOn: true, pathOf: filePathOf }),
  makeTool({ name: 'Edit', readOnly: false, safeWhenOn: false, pathOf: filePathOf }),
  makeTool({ name: 'Bash', readOnly: false, safeWhenOn: false, pathOf: () => undefined }),
  makeTool({ name: 'Crewmate', readOnly: true, safeWhenOn: true, pathOf: () => undefined }),
]

function makeCtx(): { ctx: Record<string, unknown>; abortController: AbortController } {
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
  const abortController = new AbortController()
  const ctx: Record<string, unknown> = {
    abortController,
    options: {
      commands: [],
      tools: TOOLS,
      engineModel: MODEL,
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
  }
  return { ctx, abortController }
}

type Step = { name: string; input: Record<string, unknown> }
type Script = { calls: Step[]; waitFor?: number; abortDuringPause?: boolean }
type Run = { requests: unknown[][]; yields: AnyMsg[]; ids: string[]; terminal: Record<string, unknown>; marks: string[] }

const allowAll = async (_tool: unknown, input: Record<string, unknown>) =>
  ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }) as never

async function runScript(rounds: Script[], label: string): Promise<Run> {
  marks.length = 0
  startWaiters.clear()
  let idSeq = 0
  const ids: string[] = []
  const requests: unknown[][] = []
  const rig = makeCtx()
  async function* callModel(req: { messages: unknown[] }): AsyncGenerator<never, void> {
    const index = requests.length
    requests.push([...req.messages])
    const script = rounds[index]
    if (!script) {
      const m = createAssistantMessage({ content: 'done' })
      m.message.stop_reason = 'end_turn'
      yield m as never
      return
    }
    const roundIds = script.calls.map(() => `tu_${label}_${++idSeq}`)
    ids.push(...roundIds)
    const waited = script.waitFor === undefined ? null : whenStarted(roundIds[script.waitFor]!)
    for (let i = 0; i < script.calls.length; i++) {
      const m = createAssistantMessage({ content: [{ type: 'tool_use', id: roundIds[i], name: script.calls[i]!.name, input: script.calls[i]!.input }] as never })
      m.message.id = `msg_${label}_${index}`
      m.message.stop_reason = null
      marks.push(`stream:block:${roundIds[i]}`)
      yield m as never
    }
    if (waited !== null) {
      marks.push('stream:pause')
      await Promise.race([waited, new Promise(resolve => setTimeout(resolve, STREAM_CEILING_MS))])
      if (script.abortDuringPause) {
        marks.push('stream:abort')
        rig.abortController.abort('interrupt')
      }
    }
    const tail = createAssistantMessage({ content: 'and that is the reply' })
    tail.message.id = `msg_${label}_${index}`
    tail.message.stop_reason = 'tool_use'
    marks.push('stream:end')
    yield tail as never
  }
  const gen = turnDoor({
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
  return { requests, yields, ids, terminal: r.value, marks: [...marks] }
}

function at(run: Run, mark: string): number {
  return run.marks.indexOf(mark)
}
function startOf(run: Run, name: string, id: string): number {
  return at(run, `tool:start:${name}:${id}`)
}
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const ENVIRONMENT_ROWS = new Set(['context_capsule', 'user_context'])
function withoutEnvironmentRows(rows: unknown): unknown {
  if (!Array.isArray(rows)) return rows
  return rows.filter(row => !ENVIRONMENT_ROWS.has(String((row as { attachment?: { type?: unknown } })?.attachment?.type)))
}
function normaliseRows(given: unknown): string {
  const rows = withoutEnvironmentRows(given)
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip)
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (k === 'timestamp' || k === 'durationMs' || k === 'ttftMs') continue
        out[k] = strip(v)
      }
      return out
    }
    return value
  }
  return JSON.stringify(strip(rows)).replace(UUID, '<uuid>')
}
function normalise(run: Run): string {
  return normaliseRows(run.yields)
}
function firstDifference(a: string, b: string): string {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return `at ${i}: …${a.slice(Math.max(0, i - 120), i + 200)}… vs …${b.slice(Math.max(0, i - 120), i + 200)}…`
}
function resultsOf(run: Run): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of run.yields) {
    if (m.type !== 'user') continue
    const content = (m as { message?: { content?: unknown } }).message?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Array<{ type?: string; tool_use_id?: string; content?: unknown }>) {
      if (block.type === 'tool_result' && block.tool_use_id) out.set(block.tool_use_id, String(block.content))
    }
  }
  return out
}

const GREP: Step = { name: 'Grep', input: { pattern: 'needle', path: '/tmp/early-start-tree' } }
const READ_A: Step = { name: 'Read', input: { file_path: '/tmp/early-start-tree/a.ts' } }
const READ_B: Step = { name: 'Read', input: { file_path: '/tmp/early-start-tree/b.ts' } }
const EDIT_A: Step = { name: 'Edit', input: { file_path: '/tmp/early-start-tree/a.ts', old_string: 'x', new_string: 'y' } }
const BASH: Step = { name: 'Bash', input: { command: 'bun test' } }
const CREWMATE: Step = { name: 'Crewmate', input: { prompt: 'look around', description: 'scout' } }

section('A — a safe call starts the moment its block settles, while the reply is still streaming; the settled road (the same call through an unsafe twin) is the control: same events, same bytes')
let early: Run
let control: Run
{
  safeTools = true
  early = await runScript([{ calls: [GREP], waitFor: 0 }], 'a')
  const [id] = early.ids
  check('the Grep started during the stream: after its block, before the stream ended', startOf(early, 'Grep', id!) > at(early, `stream:block:${id}`) && startOf(early, 'Grep', id!) < at(early, 'stream:end'), early.marks.join(' ') + ' — EarlyStarts.offer in src/engine/tool-dispatch/earlyStarts.ts (called from src/engine/loop/turn/makeRequest.ts) must start a safe read-only call as its block settles')
  check('the turn completed with two model calls and one settlement', early.terminal.reason === 'completed' && early.requests.length === 2 && resultsOf(early).size === 1, JSON.stringify(early.terminal) + ' — the early road in src/engine/tool-dispatch/earlyStarts.ts must hand its result to the settled round once, with no second run')
  safeTools = false
  control = await runScript([{ calls: [GREP], waitFor: 0 }], 'a')
  const [controlId] = control.ids
  check('the control: the unsafe twin started only after the stream ended', startOf(control, 'Grep', controlId!) > at(control, 'stream:end'), control.marks.join(' ') + ' — a tool that is not concurrency-safe must wait for the settled round (runTools in src/engine/tool-dispatch/toolOrchestration.ts); EarlyStarts.offer in src/engine/tool-dispatch/earlyStarts.ts must not admit it')
  check('the two transcripts are byte-identical (timestamps, uuids and the environment capsule rows aside): the same rows in the same order', normalise(early) === normalise(control), firstDifference(normalise(early), normalise(control)) + ' — the early road must yield the same rows in the same order as the settled road; compare EarlyStarts in src/engine/tool-dispatch/earlyStarts.ts with runTools in src/engine/tool-dispatch/toolOrchestration.ts')
  check('the tool outputs are byte-identical', resultsOf(early).get(id!) === resultsOf(control).get(controlId!) && resultsOf(early).get(id!) === 'Grep answered {"pattern":"needle","path":"/tmp/early-start-tree"}', `${resultsOf(early).get(id!)} vs ${resultsOf(control).get(controlId!)} — the early road in src/engine/tool-dispatch/earlyStarts.ts must carry the tool's own output unchanged`)
  check('the second request carries the result after the whole reply, and the two roads send the same request', normaliseRows(early.requests[1]).indexOf('and that is the reply') < normaliseRows(early.requests[1]).indexOf('Grep answered') && normaliseRows(control.requests[1]) === normaliseRows(early.requests[1]), firstDifference(normaliseRows(early.requests[1]), normaliseRows(control.requests[1])) + ' — the early road must put the tool result after the whole reply in the next request, as the settled road does (src/engine/tool-dispatch/earlyStarts.ts, src/engine/tool-dispatch/toolOrchestration.ts)')
  safeTools = true
}

section('B — nothing unsafe starts early: [Read a, Bash, Grep] — the Read starts in the stream, the Bash waits for the settled reply, and the Grep behind the Bash waits too')
{
  const run = await runScript([{ calls: [READ_A, BASH, GREP], waitFor: 0 }], 'b')
  const [read, bash, grep] = run.ids
  const end = at(run, 'stream:end')
  check('the Read started before the stream ended', startOf(run, 'Read', read!) < end && startOf(run, 'Read', read!) > 0, run.marks.join(' ') + ' — EarlyStarts.offer in src/engine/tool-dispatch/earlyStarts.ts must start a read-only call as its block settles')
  check('the Bash started after the stream ended', startOf(run, 'Bash', bash!) > end, run.marks.join(' ') + ' — EarlyStarts.offer in src/engine/tool-dispatch/earlyStarts.ts must admit only free or read-only claims; a write-capable call must wait for the settled round')
  check('the Grep behind the Bash started after the stream ended, and after the Bash ended', startOf(run, 'Grep', grep!) > end && startOf(run, 'Grep', grep!) > at(run, `tool:end:Bash:${bash}`), run.marks.join(' ') + ' — EarlyStarts.offer in src/engine/tool-dispatch/earlyStarts.ts must check claimsCompatible against every earlier claim, so a call behind a held unsafe claim waits')
  check('three settlements, one per call', resultsOf(run).size === 3 && run.ids.every(id => resultsOf(run).has(id)))
}

section('B2 — a crewmate launch is declared safe and read-only, and still waits for the settled reply: nothing a stream interrupt would have to tear down is started early')
{
  const run = await runScript([{ calls: [CREWMATE, GREP], waitFor: 1 }], 'b2')
  const [crew, grep] = run.ids
  check('the Grep beside it started during the stream', startOf(run, 'Grep', grep!) < at(run, 'stream:end') && startOf(run, 'Grep', grep!) > 0, run.marks.join(' ') + ' — EarlyStarts.offer in src/engine/tool-dispatch/earlyStarts.ts must start the Grep beside a refused crewmate launch')
  check('the crewmate launch started only after the stream ended', startOf(run, 'Crewmate', crew!) > at(run, 'stream:end'), run.marks.join(' ') + ' — EarlyStarts.offer in src/engine/tool-dispatch/earlyStarts.ts must refuse a call whose tool is AGENT_TOOL_NAME (launchesCrewmate)')
  check('both settled once', resultsOf(run).size === 2)
}

section('C — a reader beside a writer: a Read of another file starts early though the Edit before it waits; a Read of the edited file waits with it')
{
  const beside = await runScript([{ calls: [EDIT_A, READ_B], waitFor: 1 }], 'c1')
  const [edit, readB] = beside.ids
  check('the Read of b.ts started during the stream', startOf(beside, 'Read', readB!) < at(beside, 'stream:end'), beside.marks.join(' ') + ' — claimsCompatible in src/engine/tool-dispatch/toolBatching.ts must let a read of another path start beside a held write claim')
  check('the Edit of a.ts started only after the stream ended', startOf(beside, 'Edit', edit!) > at(beside, 'stream:end'), beside.marks.join(' ') + ' — EarlyStarts.offer in src/engine/tool-dispatch/earlyStarts.ts must keep a write call for the settled round')
  const same = await runScript([{ calls: [EDIT_A, READ_A], waitFor: 1 }], 'c2')
  const [edit2, readA] = same.ids
  check('the Read of a.ts (the edited file) started only after the stream ended, and after the Edit ended', startOf(same, 'Read', readA!) > at(same, 'stream:end') && startOf(same, 'Read', readA!) > at(same, `tool:end:Edit:${edit2}`), same.marks.join(' ') + ' — claimsCompatible in src/engine/tool-dispatch/toolBatching.ts, as used by EarlyStarts.offer in src/engine/tool-dispatch/earlyStarts.ts, must refuse a read of a path an earlier claim writes')
}

section('D — an interrupt mid-stream cancels what it always cancelled: the early call is told to stop, the stream\'s announced calls settle synthetically, and the transcript is the control\'s')
{
  callDelayMs = 20_000
  safeTools = true
  const cut = await runScript([{ calls: [GREP], waitFor: 0, abortDuringPause: true }], 'd')
  const [id] = cut.ids
  check('the early call had started before the interrupt', startOf(cut, 'Grep', id!) < at(cut, 'stream:abort'), cut.marks.join(' ') + ' — EarlyStarts.offer in src/engine/tool-dispatch/earlyStarts.ts must have started the call during the stream')
  check('the early call observed the interrupt and ended', cut.marks.includes(`tool:aborted:Grep:${id}`), cut.marks.join(' ') + ' — an early call runs under a child of the turn\'s abort controller (childAbortController in src/engine/tool-dispatch/earlyStarts.ts); the interrupt must reach it')
  check('the run ended as an aborted stream', cut.terminal.reason === 'aborted_streaming', JSON.stringify(cut.terminal) + ' — an interrupted stream must end with reason aborted_streaming (src/engine/loop/turn/modelReply.ts)')
  const synthetic = cut.yields.filter(m => m.type === 'user' && JSON.stringify(m).includes(id!) && JSON.stringify(m).includes('"is_error":true'))
  check('the announced call settled synthetically, once, as an error', synthetic.length === 1 && !JSON.stringify(cut.yields).includes('Grep answered'), JSON.stringify(cut.yields).slice(0, 600) + ' — an interrupt must settle the announced call once as an error and drop the early call\'s real output (EarlyStarts in src/engine/tool-dispatch/earlyStarts.ts)')
  safeTools = false
  const cutControl = await runScript([{ calls: [GREP], waitFor: 0, abortDuringPause: true }], 'd')
  check('the control (the unsafe twin) never started and ended the same way', startOf(cutControl, 'Grep', cutControl.ids[0]!) === -1 && cutControl.terminal.reason === 'aborted_streaming', cutControl.marks.join(' ') + ' — a call that is not concurrency-safe must not start in the stream, and the turn must still end with aborted_streaming (src/engine/loop/turn/modelReply.ts)')
  check('the interrupted transcripts are byte-identical (timestamps, uuids and the environment capsule rows aside)', normalise(cut) === normalise(cutControl), firstDifference(normalise(cut), normalise(cutControl)) + ' — an interrupted early call must leave the same rows as the settled road; compare EarlyStarts in src/engine/tool-dispatch/earlyStarts.ts with runTools in src/engine/tool-dispatch/toolOrchestration.ts')
  callDelayMs = 0
  safeTools = true
}

section('E — the loop guard still counts the early-started calls as the round\'s calls: three identical Greps, each started in its stream, draw the third-call reminder as before')
{
  const run = await runScript([{ calls: [GREP], waitFor: 0 }, { calls: [GREP], waitFor: 0 }, { calls: [GREP], waitFor: 0 }], 'e')
  const starts = run.ids.map(id => startOf(run, 'Grep', id))
  check('every one of the three started during its own stream', starts.every(s => s > 0) && run.marks.filter(m => m === 'stream:end').length === 3, run.marks.join(' ') + ' — EarlyStarts in src/engine/tool-dispatch/earlyStarts.ts must start each safe call in its own round\'s stream')
  check('the third identical call draws the reminder in the request after it', JSON.stringify(run.requests[3]).includes('this is the third identical tool call') && !JSON.stringify(run.requests[2]).includes('third identical tool call'), JSON.stringify(run.requests[3]).slice(-300) + ' — early-started calls must still be recorded with recordToolCall/openRoundCall in src/engine/tool-dispatch/loopGuard.ts so the third identical call draws its reminder')
}

section('F — a retry resets the early starts: a started call is stopped, taken no more, and the round is a new one')
{
  const { EarlyStarts } = await import('../../src/engine/tool-dispatch/earlyStarts.ts')
  const rig = makeCtx()
  const earlyStarts = new EarlyStarts(rig.ctx as never, allowAll as never)
  const parent = createAssistantMessage({ content: [{ type: 'tool_use', id: 'tu_f_1', name: 'Grep', input: GREP.input }] as never })
  callDelayMs = 20_000
  marks.length = 0
  earlyStarts.offer({ type: 'tool_use', id: 'tu_f_1', name: 'Grep', input: GREP.input } as never, parent as never, 0)
  await earlyStarts.ready()
  const before = earlyStarts.roundID
  await new Promise(resolve => setTimeout(resolve, 50))
  check('the offered safe call started', marks.includes('tool:start:Grep:tu_f_1'), marks.join(' ') + ' — EarlyStarts.offer in src/engine/tool-dispatch/earlyStarts.ts must start a safe call')
  earlyStarts.reset()
  await new Promise(resolve => setTimeout(resolve, 50))
  check('after the reset the call was told to stop, nothing can be taken, and the round id moved', marks.includes('tool:aborted:Grep:tu_f_1') && earlyStarts.take('tu_f_1') === undefined && earlyStarts.roundID !== before, marks.join(' ') + ' — EarlyStarts.reset in src/engine/tool-dispatch/earlyStarts.ts must abort started calls, clear them so take returns undefined, and assign a new roundID')
  callDelayMs = 0
}

section('refusals — an abandoned stream (provider throw after a settled tool_use block) aborts the early call and settles synthetically; a mid-stream fallback retry never double-runs; plain/implement ask while sovereign runs without asking')
{
  callDelayMs = 20_000
  marks.length = 0
  startWaiters.clear()
  const rig = makeCtx()
  const started = whenStarted('tu_err_1')
  async function* failingModel(): AsyncGenerator<never, void> {
    const m = createAssistantMessage({ content: [{ type: 'tool_use', id: 'tu_err_1', name: 'Grep', input: GREP.input }] as never })
    m.message.id = 'msg_err_0'
    m.message.stop_reason = null
    marks.push('stream:block:tu_err_1')
    yield m as never
    await Promise.race([started, new Promise(resolve => setTimeout(resolve, STREAM_CEILING_MS))])
    marks.push('stream:throw')
    throw new Error('simulated mid-stream transport failure')
  }
  const gen = turnDoor({
    messages: [createUserMessage({ content: 'please do the thing' })] as never,
    systemPrompt: ['rig system prompt'] as never,
    userContext: {},
    systemContext: {},
    canUseTool: allowAll as never,
    toolUseContext: rig.ctx as never,
    querySource: 'sdk' as never,
    deps: {
      callModel: failingModel as never,
      autocompact: (async () => ({ wasCompacted: false })) as never,
      microcompact: (async (messages: unknown[]) => ({ messages })) as never,
      uuid: (() => {
        let n = 0
        return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
      })(),
    },
  }) as AsyncGenerator<AnyMsg, Record<string, unknown>>
  const errYields: AnyMsg[] = []
  let step = await gen.next()
  while (!step.done) {
    errYields.push(step.value)
    step = await gen.next()
  }
  await new Promise(resolve => setTimeout(resolve, 30))
  check('abandoned stream: the early call started before the throw and was aborted when the stream failed', marks.includes('tool:start:Grep:tu_err_1') && marks.includes('tool:aborted:Grep:tu_err_1'), marks.join(' ') + ' — a stream that throws after a settled tool_use block must abort the early call; look at EarlyStarts in src/engine/tool-dispatch/earlyStarts.ts and its caller src/engine/loop/turn/makeRequest.ts')
  const errSettlements = errYields.filter(m => m.type === 'user' && JSON.stringify(m).includes('tu_err_1'))
  check('abandoned stream: the announced call settled synthetically once as an error and never leaked its real output', step.value.reason === 'model_error' && errSettlements.length === 1 && !JSON.stringify(errYields).includes('Grep answered'), JSON.stringify(step.value) + ' — after a model_error the announced call must settle once as a synthetic error and never leak the early call\'s output (src/engine/turnDoor.ts, src/engine/tool-dispatch/earlyStarts.ts)')
  callDelayMs = 0

  marks.length = 0
  startWaiters.clear()
  const retryRig = makeCtx()
  const firstStarted = whenStarted('tu_retry_1')
  let modelCalls = 0
  async function* fallbackStreamModel(req: { options: { onStreamingFallback?: () => void } }): AsyncGenerator<never, void> {
    modelCalls++
    if (modelCalls === 1) {
      const m1 = createAssistantMessage({ content: [{ type: 'tool_use', id: 'tu_retry_1', name: 'Grep', input: GREP.input }] as never })
      m1.message.id = 'msg_retry_1'
      m1.message.stop_reason = null
      marks.push('stream:block:tu_retry_1')
      yield m1 as never
      await Promise.race([firstStarted, new Promise(resolve => setTimeout(resolve, STREAM_CEILING_MS))])
      marks.push('stream:fallback')
      req.options.onStreamingFallback?.()
      const m2 = createAssistantMessage({ content: [{ type: 'tool_use', id: 'tu_retry_2', name: 'Grep', input: GREP.input }] as never })
      m2.message.id = 'msg_retry_2'
      m2.message.stop_reason = 'tool_use'
      marks.push('stream:block:tu_retry_2')
      yield m2 as never
      return
    }
    const done = createAssistantMessage({ content: 'done' })
    done.message.stop_reason = 'end_turn'
    yield done as never
  }
  const retryGen = turnDoor({
    messages: [createUserMessage({ content: 'please do the thing' })] as never,
    systemPrompt: ['rig system prompt'] as never,
    userContext: {},
    systemContext: {},
    canUseTool: allowAll as never,
    toolUseContext: retryRig.ctx as never,
    querySource: 'sdk' as never,
    deps: {
      callModel: fallbackStreamModel as never,
      autocompact: (async () => ({ wasCompacted: false })) as never,
      microcompact: (async (messages: unknown[]) => ({ messages })) as never,
      uuid: (() => {
        let n = 0
        return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
      })(),
    },
  }) as AsyncGenerator<AnyMsg, Record<string, unknown>>
  const retryYields: AnyMsg[] = []
  let rs = await retryGen.next()
  while (!rs.done) {
    retryYields.push(rs.value)
    rs = await retryGen.next()
  }
    const retryUserRows = retryYields.filter(m => m.type === 'user')
    const retryUserText = JSON.stringify(retryUserRows)
    check('mid-stream fallback: the first attempt\'s early call is retracted and never settled in the user tool_result rows; only the retry\'s call settles once', !retryUserText.includes('tu_retry_1') && retryUserText.includes('tu_retry_2') && marks.filter(m => m === 'tool:start:Grep:tu_retry_1').length === 1 && marks.filter(m => m === 'tool:start:Grep:tu_retry_2').length === 1, marks.join(' ') + ' — on onStreamingFallback the first attempt\'s early call must be retracted with EarlyStarts.reset (src/engine/tool-dispatch/earlyStarts.ts) and only the retry\'s call settled')

  const { decideToolPermissionWithModes } = await import('../../src/permissions/rules/decision/wrapper.ts')
  const { ReadTool } = await import('../../src/tools/read/ReadTool.ts')
  const askInput = { file_path: '/etc/hosts' }
  const askParent = createAssistantMessage({ content: [{ type: 'tool_use', id: 'tu_mode_1', name: 'Read', input: askInput }] as never })
  const modeVerdict = async (mode: 'default' | 'implement' | 'sovereign') => {
    const base = getDefaultAppState()
    const mCtx = makeCtx()
    mCtx.ctx.options = { ...(mCtx.ctx.options as Record<string, unknown>), isNonInteractiveSession: false }
    mCtx.ctx.getAppState = () => ({
      ...base,
      toolPermissionContext: {
        ...base.toolPermissionContext,
        mode,
        isBypassPermissionsModeAvailable: mode === 'sovereign',
        alwaysAskRules: { userSettings: ['Read(/etc/hosts)'] },
      },
    })
    return (await decideToolPermissionWithModes(ReadTool as never, askInput, mCtx.ctx as never, askParent as never, 'tu_mode_1')).decision.behavior
  }
  const plainVerdict = await modeVerdict('default')
  const implementVerdict = await modeVerdict('implement')
  const sovereignVerdict = await modeVerdict('sovereign')
  check('permission modes on an early-eligible Read under an ask rule: plain and implement ask, sovereign allows without asking', plainVerdict === 'ask' && implementVerdict === 'ask' && sovereignVerdict === 'allow', `plain=${plainVerdict} implement=${implementVerdict} sovereign=${sovereignVerdict} — decideToolPermissionWithModes in src/permissions/rules/decision/wrapper.ts must ask in default and implement modes under an always-ask rule and allow in sovereign`)
}

console.log('\n' + '='.repeat(76))
if (failures > 0) {
  console.log(`EARLY-TOOL-START: ${failures} of ${checks} checks FAILED`)
  process.exit(1)
}
console.log(`EARLY-TOOL-START: all ${checks} checks passed`)
process.exit(0)
