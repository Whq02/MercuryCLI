#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWorkflowAgentFixture } from '../lib/workflowAgentFixture.ts'
import {
  addWorkflowUsage,
  EMPTY_WORKFLOW_USAGE,
  foldResponseUsage,
  readWorkflowUsage,
  rollupWorkflowUsage,
  usageSpeaks,
  workflowSpendWords,
  workflowUsageSpend,
} from '../../src/tools/WorkflowTool/workflowUsage.ts'

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the fleet spend proof exceeded 170s')
  process.exit(1)
}, 170_000)
guard.unref?.()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const REPO = join(new URL('.', import.meta.url).pathname, '../..')
const BUN = process.env.BUN ?? join(homedir(), '.bun/bin/bun')
const scratch = mkdtempSync(join(tmpdir(), 'wf-fleet-spend-'))
const GPT = 'gpt-6-astra'
const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

console.log('============================================================')
console.log(' Fleet spend — the run record carries real accumulated usage')
console.log('============================================================')

section('§1 the pure law')
{
  const settled = foldResponseUsage(EMPTY_WORKFLOW_USAGE, {
    stop_reason: 'end_turn',
    usage: { input_tokens: 9, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 },
  })
  check('a settled response folds its four counts and one turn', settled.inputTokens === 9 && settled.outputTokens === 7 && settled.cacheReadTokens === 100 && settled.cacheCreationTokens === 5 && settled.apiTurns === 1 && settled.unsettledTurns === 0, JSON.stringify(settled))
  check('the spend is the input with the cached prefix counted in, plus the output', workflowUsageSpend(settled) === 121)
  const cut = foldResponseUsage(settled, { stop_reason: null, usage: { input_tokens: 9, output_tokens: 0 } })
  check('a response that ended without a settled usage is one unmeasured turn, its counts never summed', cut.unsettledTurns === 1 && cut.apiTurns === 1 && cut.inputTokens === 9 && cut.outputTokens === 7, JSON.stringify(cut))
  const noUsage = foldResponseUsage(settled, { stop_reason: 'end_turn', usage: null })
  check('a response with no usage at all is unmeasured too', noUsage.unsettledTurns === 1)
  const sum = addWorkflowUsage(settled, cut)
  check('records add count by count', sum.inputTokens === 18 && sum.apiTurns === 2 && sum.unsettledTurns === 1)
  check('a record is read whole', readWorkflowUsage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4, apiTurns: 1, unsettledTurns: 0 }) !== undefined)
  check('…or not at all: a missing count is no record', readWorkflowUsage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, apiTurns: 1, unsettledTurns: 0 }) === undefined)
  check('…a non-finite or negative count is no record', readWorkflowUsage({ ...settled, outputTokens: Number.NaN }) === undefined && readWorkflowUsage({ ...settled, apiTurns: -1 }) === undefined)
  check('…and a string is no record', readWorkflowUsage('18') === undefined)
  const rolled = rollupWorkflowUsage([{ usage: settled }, { usage: cut }, {}, { usage: { bogus: true } }])
  check('the rollup sums the reporting agents and counts the rest', rolled !== undefined && rolled.inputTokens === 18 && rolled.apiTurns === 2 && rolled.unsettledTurns === 1 && rolled.agentsReporting === 2 && rolled.agentsUnreported === 2, JSON.stringify(rolled))
  check('no agent reporting ⇒ no rollup (unknown, not zero)', rollupWorkflowUsage([{}, { usage: null }]) === undefined)
  check('an empty record says nothing yet', !usageSpeaks(EMPTY_WORKFLOW_USAGE) && usageSpeaks(settled) && usageSpeaks({ ...EMPTY_WORKFLOW_USAGE, unsettledTurns: 1 }))
  check('the words: the spend, and the unmeasured turns beside it', workflowSpendWords(settled, fmt) === '121 spent' && workflowSpendWords(cut, fmt) === '121 spent · 1 turn unmeasured' && workflowSpendWords({ ...cut, unsettledTurns: 2 }, fmt) === '121 spent · 2 turns unmeasured')
}

const fixture = await startWorkflowAgentFixture({ port: 34911, gptId: GPT, latencyMs: { anthropic: 600 } })

const CHILD = String.raw`
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
delete process.env.NODE_ENV
delete process.env.MERCURY_EFFORT_LEVEL
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'wf-fleet-spend-home-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
await import('${REPO}/src/tasks.js')
const { enableConfigs } = await import('${REPO}/src/utils/config/globalConfig.js')
enableConfigs()
const { WorkflowTool } = await import('${REPO}/src/tools/WorkflowTool/WorkflowTool.js')
const { makeWorkflowHooks } = await import('${REPO}/src/tools/WorkflowTool/agentHooks.js')
const { getDefaultAppState } = await import('${REPO}/src/state/AppStateStore.js')
const { dequeueAll } = await import('${REPO}/src/input-core/command-queue.js')
const emit = (o: unknown) => console.log('@@' + JSON.stringify(o))

let state: any = getDefaultAppState()
const setAppState = (fn: any) => { state = typeof fn === 'function' ? fn(state) : fn }
const ctx: any = {
  getAppState: () => state,
  setAppState,
  setAppStateForTasks: setAppState,
  options: {
    mainLoopModel: 'claude-opus-4-8',
    mcpClients: [],
    mcpResources: {},
    tools: [],
    commands: [],
    debug: false,
    verbose: false,
    isNonInteractiveSession: false,
    agentDefinitions: { activeAgents: [], allAgents: [] },
  },
  abortController: new AbortController(),
  toolUseId: 'fleet-spend-tool-use',
  readFileState: { readFileState: new Map(), clear: () => {} },
}

const script = [
  "export const meta = { name: 'fleet-spend', description: 'two agents, two wires', phases: [{ title: 'Survey' }] }",
  "phase('Survey')",
  "const one = await agent('station one: run the echo command you are told to run, then reply done', {})",
  "const two = await agent('station two: run the echo command you are told to run, then reply done', { model: '${GPT}' })",
  "return { one, two }",
].join('\n')

try {
  const res = await WorkflowTool.call({ script }, ctx, async () => ({ behavior: 'allow' }))
  const d: any = (res as any).data
  emit({ ev: 'launched', runId: d.runId, runDir: d.transcriptDir, error: d.error })
  const runDir = d.transcriptDir
  const deadline = Date.now() + 90_000
  let task: any
  for (;;) {
    task = Object.values(state.tasks ?? {}).find((t: any) => t.type === 'local_workflow')
    if (task && task.status !== 'running') break
    if (Date.now() > deadline) { emit({ ev: 'timeout', status: task?.status, progress: task?.workflowProgress?.slice(-6) }); process.exit(1) }
    await new Promise(r => setTimeout(r, 100))
  }
  const manifest = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'))
  const queued = dequeueAll().map((c: any) => String(c.value ?? ''))
  const usageLine = queued.map((v: string) => v.match(/<usage>.*<\/usage>/s)?.[0] ?? '').find((s: string) => s !== '') ?? ''
  emit({
    ev: 'settled',
    status: task.status,
    error: task.error,
    taskUsage: task.usage ?? null,
    taskTotalTokens: task.totalTokens,
    manifestUsage: manifest.usage ?? null,
    manifestTotalTokens: manifest.totalTokens,
    agents: (manifest.agents ?? []).map((a: any) => ({ index: a.index, state: a.state, model: a.model, tokens: a.tokens, usage: a.usage ?? null })),
    usageLine,
    logs: (task.logs ?? []).slice(-5),
  })

  // §3 a request cut before any response answered: the direct hooks with the
  // operator's skip landing inside the fixture's held first response.
  const frames: any[] = []
  const controllers = new Map<string, AbortController>()
  const hooks: any = makeWorkflowHooks({
    toolUseContext: ctx,
    canUseTool: async () => ({ behavior: 'allow' }),
    emitProgress: (f: any) => frames.push(JSON.parse(JSON.stringify(f?.data ?? null))),
    workflowRunId: 'fleet-spend-cut',
    onAgentController: (id: string, c: AbortController | null) => {
      if (c) controllers.set(id, c)
      else controllers.delete(id)
    },
  } as any)
  const cutTimer = setInterval(() => {
    const [first] = controllers.values()
    if (first && !first.signal.aborted) {
      first.abort('user-skip')
      clearInterval(cutTimer)
    }
  }, 250)
  let cutResult: unknown
  try {
    cutResult = await hooks.agent('cut agent: run the echo command you are told to run, then reply done', {})
  } catch (e) {
    cutResult = { threw: (e as Error).message }
  }
  clearInterval(cutTimer)
  const agentFrames = frames.filter((f: any) => f?.type === 'workflow_agent')
  emit({ ev: 'cut', last: agentFrames.at(-1) ?? null, result: cutResult })
  const nudgeFrames: any[] = []
  let nudgeAttempt = 0
  const nudgeHooks: any = makeWorkflowHooks({
    toolUseContext: ctx,
    canUseTool: async () => ({ behavior: 'allow' }),
    emitProgress: (frame: any) => nudgeFrames.push(frame.data),
    spawnSubagentStream: async function* () {
      nudgeAttempt++
      yield { type: 'assistant', message: { id: 'response-' + nudgeAttempt, content: [{ type: 'text', text: 'finished' }], stop_reason: 'end_turn', usage: { input_tokens: nudgeAttempt === 1 ? 9000 : 80, output_tokens: nudgeAttempt === 1 ? 200 : 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
      if (nudgeAttempt === 2) yield { type: 'attachment', attachment: { type: 'structured_output', data: { ok: true } } }
    },
  })
  const nudgeResult = await nudgeHooks.agent('Return the structured result', { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } })
  emit({ ev: 'nudge', attempts: nudgeAttempt, result: nudgeResult, usage: nudgeFrames.filter((frame: any) => frame.type === 'workflow_agent').at(-1)?.usage })
  process.exit(0)
} catch (e) {
  emit({ ev: 'threw', message: (e as Error).message, stack: String((e as Error).stack).slice(0, 600) })
  process.exit(1)
}
`
writeFileSync(join(scratch, 'child.ts'), CHILD)

section('drive: one workflow, two agents on two wires (real stack, loopback)')
const child = spawn(BUN, ['run', join(scratch, 'child.ts')], {
  cwd: scratch,
  env: { ...process.env, ...fixture.env, MERCURY_DYNAMIC_WORKFLOWS: '1' },
})
const lines: Array<Record<string, unknown>> = []
let out = ''
let errTail = ''
child.stdout.on('data', (d: Buffer) => {
  out += d.toString()
})
child.stderr.on('data', (d: Buffer) => {
  errTail = (errTail + d.toString()).slice(-2000)
})
const status: number | null = await new Promise(resolve => {
  const killer = setTimeout(() => child.kill('SIGKILL'), 140_000)
  child.on('close', s => {
    clearTimeout(killer)
    resolve(s)
  })
})
for (const line of out.split('\n')) {
  if (line.startsWith('@@')) {
    try {
      lines.push(JSON.parse(line.slice(2)))
    } catch {
    }
  }
}
type AgentRow = { index: number; state: string; model?: string; tokens?: number; usage: Record<string, number> | null }
type Settled = {
  status?: string
  error?: string
  taskUsage: Record<string, number> | null
  taskTotalTokens?: number
  manifestUsage: Record<string, number> | null
  manifestTotalTokens?: number
  agents?: AgentRow[]
  usageLine?: string
}
const launched = lines.find(l => l.ev === 'launched')
const settled = lines.find(l => l.ev === 'settled') as Settled | undefined
const cut = lines.find(l => l.ev === 'cut') as { last?: Record<string, unknown> | null } | undefined

section('§2 the record on both dialects')
check('child exited 0', status === 0, `status ${status}; stderr tail: ${errTail.slice(-500)}; lines: ${JSON.stringify(lines).slice(0, 800)}`)
check('workflow launched and completed', !!launched && settled?.status === 'completed', JSON.stringify(settled).slice(0, 600))
const agents = settled?.agents ?? []
check('two agents in the record, both done', agents.length === 2 && agents.every(a => a.state === 'done'), JSON.stringify(agents))
const responsesAgent = agents.find(a => a.model === GPT)
const anthropicAgent = agents.find(a => a.model !== GPT)
check(`one agent ran on ${GPT} and one on the session's Anthropic model`, responsesAgent !== undefined && anthropicAgent?.model === 'claude-opus-4-8', agents.map(a => `${a.index}:${a.model}`).join(','))
const served = fixture.captured.filter(h => h.lane === 'anthropic' || h.lane === 'responses')
check('the fixture answered the run with two requests per wire (and the cut agent one more)', served.filter(h => h.lane === 'anthropic').length === 3 && served.filter(h => h.lane === 'responses').length === 2, served.map(h => h.lane).join(','))
const expectAgent = (a: AgentRow | undefined, name: string): void => {
  const u = a?.usage
  check(`${name}: the record accumulates both responses (18 in, 10 out, 2 turns, 0 unmeasured)`, !!u && u.inputTokens === 18 && u.outputTokens === 10 && u.cacheReadTokens === 0 && u.cacheCreationTokens === 0 && u.apiTurns === 2 && u.unsettledTurns === 0, JSON.stringify(a))
  check(`${name}: the context figure is the newest response's size (12), not zero`, a?.tokens === 12, String(a?.tokens))
}
expectAgent(anthropicAgent, 'Anthropic wire')
expectAgent(responsesAgent, 'Responses wire')
const run = settled?.manifestUsage
check('run.json rolls the fleet up: 36 in, 20 out, 4 turns, 2 reporting, 0 unreported', !!run && run.inputTokens === 36 && run.outputTokens === 20 && run.apiTurns === 4 && run.unsettledTurns === 0 && run.agentsReporting === 2 && run.agentsUnreported === 0, JSON.stringify(run))
check('the task state carries the same rollup', JSON.stringify(settled?.taskUsage) === JSON.stringify(run))
check('the context sum is the two newest sizes (24) on the task and the record', settled?.taskTotalTokens === 24 && settled?.manifestTotalTokens === 24, `${settled?.taskTotalTokens}/${settled?.manifestTotalTokens}`)

section('§3 a request cut before any response answered')
const last = cut?.last
const cutUsage = last ? readWorkflowUsage(last.usage) : undefined
check('the skipped attempt settled with a record', last?.state === 'skipped' && cutUsage !== undefined, JSON.stringify(last).slice(0, 400))
check('…that says one turn unmeasured and nothing settled — never 0 spent', !!cutUsage && cutUsage.apiTurns === 0 && cutUsage.unsettledTurns === 1 && workflowUsageSpend(cutUsage) === 0 && workflowSpendWords(cutUsage, fmt) === '0 spent · 1 turn unmeasured', JSON.stringify(cutUsage))
check('…and the rollup over such an agent carries the unmeasured turn', (() => {
  const r = rollupWorkflowUsage([{ usage: cutUsage }])
  return r !== undefined && r.unsettledTurns === 1 && r.agentsReporting === 1
})())

const nudge = lines.find(line => line.ev === 'nudge') as { attempts?: number; usage?: { inputTokens: number; outputTokens: number; apiTurns: number } } | undefined
check('structured-output corrections retain all earlier spend exactly once', nudge?.attempts === 2 && nudge.usage?.inputTokens === 9080 && nudge.usage.outputTokens === 220 && nudge.usage.apiTurns === 2, JSON.stringify(nudge))

section('§4 the notification spells the spend beside the context sum')
const usageLine = settled?.usageLine ?? ''
check('the <usage> section carries subagent_tokens (the context sum)', usageLine.includes('<subagent_tokens>24</subagent_tokens>'), usageLine)
check('…and subagent_spend with the accumulated counts and what they cover', usageLine.includes('<subagent_spend tokens="56" input="36" cache_read="0" cache_creation="0" output="20" api_turns="4" unsettled_turns="0" agents_reporting="2" agents_unreported="0"/>'), usageLine)

await fixture.close()
rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
