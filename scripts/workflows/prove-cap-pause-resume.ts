#!/usr/bin/env bun

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cap-pause-resume-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.OPENAI_API_KEY = 'fixture-openai-key'
delete process.env.MERCURY_CAP_FAILOVER

const { makeWorkflowHooks } = await import('../../src/tools/WorkflowTool/agentHooks.js')
const { setMainLoopModelOverride } = await import('../../src/bootstrap/state.js')
const { recordOpenaiUsageLimit, __resetOpenaiLimitStateForTest } = await import('../../src/services/providers/openai/openaiLimitState.js')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

type SpawnCall = { prompt: string; model?: string; continuationMessages?: unknown[] }
type Frame = { type?: string; data?: Record<string, unknown> }

function textEvent(text: string) {
  return {
    type: 'assistant' as const,
    message: { content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 30 }, stop_reason: 'end_turn' },
  }
}
function capEvent(text: string) {
  return {
    type: 'assistant' as const,
    isApiErrorMessage: true,
    error: 'rate_limit',
    message: { content: [{ type: 'text', text }], usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: null },
  }
}
function faultEvent(text: string) {
  return { ...capEvent(text), error: 'server_error' }
}

function makeHarness(script: Array<(call: SpawnCall) => unknown[]>, abortController = new AbortController()) {
  const calls: SpawnCall[] = []
  const frames: Frame[] = []
  const logs: string[] = []
  const fakeSpawn = async function* (args: { prompt: string; model?: string; continuationMessages?: unknown[] }) {
    const call: SpawnCall = { prompt: args.prompt, model: args.model, continuationMessages: args.continuationMessages }
    const step = script[calls.length] ?? script[script.length - 1]!
    calls.push(call)
    for (const ev of step(call)) yield ev as never
  }
  const hooks = makeWorkflowHooks({
    toolUseContext: {
      abortController,
      getAppState: () => ({
        toolPermissionContext: { mode: 'default', additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {} },
        mcp: { tools: [] },
      }),
      options: { agentDefinitions: { activeAgents: [] }, mainLoopModel: 'claude-fable-5-1' },
    },
    canUseTool: async () => ({ behavior: 'allow' }),
    emitProgress: (frame: Frame) => {
      frames.push(frame)
      if (frame.data?.type === 'workflow_log') logs.push(String(frame.data.message))
    },
    workflowRunId: undefined,
    onAgentController: () => {},
    seedPhaseTitles: [],
    args: undefined,
    spawnSubagentStream: fakeSpawn as never,
  } as never) as {
    agent: (p: string, o?: Record<string, unknown>) => Promise<unknown>
    parallel: (thunks: Array<() => Promise<unknown>>) => Promise<unknown[]>
  }
  const agentFrames = (): Array<Record<string, unknown>> => frames.filter(f => f.data?.type === 'workflow_agent').map(f => f.data!)
  const lastAgentFrame = (): Record<string, unknown> | undefined => agentFrames()[agentFrames().length - 1]
  return { hooks, calls, frames, logs, agentFrames, lastAgentFrame }
}

const settledOf = async <T,>(p: Promise<T>, ms: number): Promise<{ settled: true; value: T } | { settled: false }> =>
  Promise.race([p.then(value => ({ settled: true as const, value })), sleep(ms).then(() => ({ settled: false as const }))])

console.log('============================================================')
console.log(' cap pause and resume — a cap never kills a workflow agent')
console.log('============================================================')

section('P1/P2 the pause on the Fable row, the switch to the GPT row resumes it')
{
  setMainLoopModelOverride(undefined)
  const { hooks, calls, logs, lastAgentFrame } = makeHarness([
    () => [textEvent('half the work is done'), capEvent("Anthropic says this account's session limit is reached on Fable 5.1 · resets 4:06 pm")],
    () => [textEvent('finished on the new row')],
  ])
  const pending = hooks.agent('write the report', { model: 'claude-fable-5-1' })
  const early = await settledOf(pending, 400)
  check('P1 agent() is PENDING on the cap (never null, never a throw)', early.settled === false, JSON.stringify(early))
  check('P1 exactly one spawn so far', calls.length === 1, `calls=${calls.length}`)
  const paused = lastAgentFrame()
  check("P1 the frame stays 'progress' and waits on the usage window", paused?.state === 'progress' && paused?.waiting === 'usage-window', JSON.stringify(paused))
  const words = String(paused?.waitWords ?? '')
  check("P1 the words: paused — usage limit: Fable 5.1's window is spent … the doors", /^paused — usage limit: Fable 5\.1's /.test(words) && / is spent; /.test(words) && /; \/model switches this agent, \/workflows stops it$/.test(words), words)
  check('P1 the words say no reset is stated when the wire stated none (this process holds no Anthropic latch)', /no reset stated/.test(words), words)
  check('P1 the log names the pause', logs.some(l => l.includes('paused —') && l.includes('/model switches this agent')), logs.join(' | ').slice(0, 300))

  setMainLoopModelOverride('gpt-5.6-sol')
  const late = await settledOf(pending, 5_000)
  check('P2 the switch lifted the pause and agent() resolved the resumed text', late.settled === true && late.value === 'finished on the new row', JSON.stringify(late))
  check('P2 exactly two spawns: the walled attempt and the resumed one', calls.length === 2, `calls=${calls.length}`)
  const resumed = calls[1]!
  check('P2 the resumed spawn runs the NEW model', resumed.model === 'gpt-5.6-sol', JSON.stringify(resumed.model))
  const carried = JSON.stringify(resumed.continuationMessages ?? [])
  check('P2 the resumed spawn CONTINUES the conversation (the ask and the completed work ride)', carried.includes('write the report') && carried.includes('half the work is done'), carried.slice(0, 300))
  check('P2 the wall row itself never rides the continuation', !carried.includes('session limit is reached'), carried.slice(0, 300))
  check('P2 the continuation ends on the resume note (do NOT redo it)', carried.includes('spent usage window') && carried.includes('do NOT redo it'), carried.slice(-300))
  check('P2 the log names the resume and the model', logs.some(l => /the model switched to gpt-5\.6-sol — resumed/.test(l)), logs.join(' | ').slice(0, 300))
  const done = lastAgentFrame()
  check("P2 the terminal frame is 'done' on the GPT badge", done?.state === 'done' && done?.model === 'gpt-5.6-sol', JSON.stringify(done))
  setMainLoopModelOverride(undefined)
}

section('P3 an OpenAI wall with a stated reset resumes on the same model when the reset passes')
{
  __resetOpenaiLimitStateForTest()
  recordOpenaiUsageLimit(Date.now() + 1_200, 'api-key')
  const { hooks, calls, lastAgentFrame } = makeHarness([
    () => [capEvent('API Error: the OpenAI API key (env) usage window is reached (openai-usage_limit_reached)')],
    () => [textEvent('finished after the reset')],
  ])
  const t0 = Date.now()
  const pending = hooks.agent('sum the ledger', { model: 'gpt-5.6-sol' })
  const early = await settledOf(pending, 300)
  check('P3 agent() is PENDING on the wall', early.settled === false)
  const paused = lastAgentFrame()
  const words = String(paused?.waitWords ?? '')
  check('P3 the words name the stated reset as a clock and a countdown', /^paused — usage limit: GPT-5\.6 Sol's / .test(words) && /resumes by itself at \d\d:\d\d \(in [0-9hms]+\); \/model switches this agent, \/workflows stops it$/.test(words), words)
  const late = await settledOf(pending, 6_000)
  check('P3 the reset lifted the pause without a switch', late.settled === true && late.value === 'finished after the reset', JSON.stringify(late))
  check('P3 the pause held until the stated reset (not before)', Date.now() - t0 >= 1_200, `${Date.now() - t0}ms`)
  check('P3 the resumed spawn runs the SAME model', calls.length === 2 && calls[1]!.model === 'gpt-5.6-sol', JSON.stringify(calls.map(c => c.model)))
  check('P3 a first-call wall resumes from the prompt with no continuation (nothing to continue)', calls[1]!.continuationMessages === undefined, JSON.stringify(calls[1]!.continuationMessages ?? null).slice(0, 200))
  __resetOpenaiLimitStateForTest()
}

section('P4 a two-agent fan-out: the capped one waits, the other settles; the switch settles the fan-out')
{
  setMainLoopModelOverride(undefined)
  const { hooks, calls, agentFrames } = makeHarness([
    call => (call.prompt.startsWith('alpha') ? [capEvent('Anthropic says this account\'s session limit is reached on Fable 5.1')] : [textEvent('beta done')]),
    call => (call.prompt.startsWith('alpha') ? [textEvent('alpha done after the switch')] : [textEvent('beta done')]),
  ])
  const fanout = hooks.parallel([
    () => hooks.agent('alpha: the walled one', { model: 'claude-fable-5-1' }),
    () => hooks.agent('beta: the other family', { model: 'gpt-5.6-sol' }),
  ])
  await sleep(500)
  const betaDone = agentFrames().some(f => String(f.label).startsWith('beta') && f.state === 'done')
  const alphaWaiting = agentFrames().filter(f => String(f.label).startsWith('alpha')).some(f => f.waiting === 'usage-window')
  check('P4 the other family\'s agent settled while the capped one waits', betaDone && alphaWaiting, JSON.stringify(agentFrames().map(f => ({ label: f.label, state: f.state, waiting: f.waiting }))))
  const early = await settledOf(fanout, 300)
  check('P4 the fan-out is still open (the capped agent is part of it)', early.settled === false)
  setMainLoopModelOverride('gpt-5.6-sol')
  const late = await settledOf(fanout, 5_000)
  check('P4 the switch settled the fan-out with both results', late.settled === true && JSON.stringify(late.value) === JSON.stringify(['alpha done after the switch', 'beta done']), JSON.stringify(late))
  check('P4 three spawns: alpha walled, beta, alpha resumed', calls.length === 3, `calls=${calls.length}`)
  setMainLoopModelOverride(undefined)
}

section('P5 the abort during a pause; a non-cap api error keeps the old road')
{
  setMainLoopModelOverride(undefined)
  const abort = new AbortController()
  const { hooks } = makeHarness([() => [capEvent('Anthropic says this account\'s session limit is reached')]], abort)
  const pending = hooks.agent('doomed', { model: 'claude-fable-5-1' })
  const early = await settledOf(pending, 300)
  check('P5 pending on the cap', early.settled === false)
  abort.abort('workflow-abort')
  const outcome = await Promise.race([pending.then(v => ({ kind: 'resolved', v })).catch(e => ({ kind: 'threw', message: e instanceof Error ? e.message : String(e) })), sleep(3_000).then(() => ({ kind: 'hung' }))])
  check('P5 the abort ends the paused agent as a workflow abort (never a hung promise)', outcome.kind === 'threw' && /Workflow aborted/.test((outcome as { message: string }).message), JSON.stringify(outcome))

  const { hooks: plain, calls: plainCalls, logs: plainLogs } = makeHarness([() => [faultEvent('API Error: 500 the provider fell over')]])
  const result = await Promise.race([plain.agent('plain fault', { model: 'claude-fable-5-1' }), sleep(3_000).then(() => 'hung')])
  check('P5 a non-cap api error keeps the old road: null, one attempt, a recorded failure', result === null && plainCalls.length === 1 && plainLogs.some(l => l.includes('failed:')), JSON.stringify({ result, calls: plainCalls.length, logs: plainLogs }))
}

console.log(failures === 0 ? '\nprove-cap-pause-resume: ALL LAWS HOLD' : `\nprove-cap-pause-resume: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
