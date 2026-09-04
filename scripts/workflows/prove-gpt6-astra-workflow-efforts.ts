#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWorkflowAgentFixture, WF_FIXTURE_DONE } from '../lib/workflowAgentFixture.ts'

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the workflow efforts prover exceeded 150s')
  process.exit(1)
}, 150_000)
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
const scratch = mkdtempSync(join(tmpdir(), 'wf-astra-efforts-'))
const ID = 'gpt-6-astra'
const LADDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const CALLS = [
  { mark: 'station one', effort: 'max' },
  { mark: 'station two', effort: 'high' },
] as const

console.log('============================================================')
console.log(' GPT-6 Astra — a workflow call carries its own effort word')
console.log('============================================================')

const fixture = await startWorkflowAgentFixture({
  port: 34907,
  reasoning: { responses: true },
  gptId: ID,
  gptReasoningLevels: LADDER,
})

const CHILD = String.raw`
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
delete process.env.NODE_ENV
delete process.env.MERCURY_EFFORT_LEVEL
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'wf-astra-efforts-home-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
await import('${REPO}/src/tasks.js')
const { enableConfigs } = await import('${REPO}/src/utils/config/globalConfig.js')
enableConfigs()
const { WorkflowTool } = await import('${REPO}/src/tools/WorkflowTool/WorkflowTool.js')
const { getDefaultAppState } = await import('${REPO}/src/state/AppStateStore.js')
const { readAgentTranscript, resolveAgentTranscriptFile } = await import('${REPO}/src/tools/WorkflowTool/agentTranscriptReader.js')
const emit = (o: unknown) => console.log('@@' + JSON.stringify(o))

let state: any = getDefaultAppState()
const setAppState = (fn: any) => { state = typeof fn === 'function' ? fn(state) : fn }
const ctx: any = {
  getAppState: () => state,
  setAppState,
  setAppStateForTasks: setAppState,
  options: {
    mainLoopModel: 'claude-fable-5-1',
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
  toolUseId: 'astra-efforts-tool-use',
  readFileState: { readFileState: new Map(), clear: () => {} },
}

const script = [
  "export const meta = { name: 'astra-efforts', description: 'two calls, two effort words', phases: [{ title: 'Survey' }] }",
  "phase('Survey')",
  "const one = await agent('station one: run the echo command you are told to run, then reply done', { model: '${ID}', effort: 'max' })",
  "const two = await agent('station two: run the echo command you are told to run, then reply done', { model: '${ID}', effort: 'high' })",
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
  const agents = (task.workflowProgress ?? []).filter((e: any) => e.type === 'workflow_agent')
  const legs: any[] = []
  for (const a of agents) {
    const file = resolveAgentTranscriptFile([manifest.transcriptDir, ...(manifest.transcriptDirs ?? [])], a.agentId)
    if (file) {
      const flushDeadline = Date.now() + 5000
      while (Date.now() < flushDeadline) {
        if (existsSync(file)) {
          const v = await readAgentTranscript(file)
          if (v && v.finalText !== undefined) break
        }
        await new Promise(r => setTimeout(r, 150))
      }
    }
    const view = file && existsSync(file) ? await readAgentTranscript(file) : undefined
    legs.push({
      index: a.index,
      state: a.state,
      model: a.model,
      effort: a.effort,
      readerReasoning: view?.reasoningTotal,
      readerUnreadableReasoning: view?.unreadableReasoningTotal,
      readerFinalText: view?.finalText?.slice(0, 80),
      error: a.error,
    })
  }
  emit({ ev: 'settled', status: task.status, error: task.error, legs, logs: (task.logs ?? []).slice(-5) })
  process.exit(0)
} catch (e) {
  emit({ ev: 'threw', message: (e as Error).message, stack: String((e as Error).stack).slice(0, 600) })
  process.exit(1)
}
`
writeFileSync(join(scratch, 'child.ts'), CHILD)

section('drive: one workflow, two calls on the row (real stack, loopback wires)')
const child = spawn(BUN, ['run', join(scratch, 'child.ts')], {
  cwd: scratch,
  env: {
    ...process.env,
    ...fixture.env,
    MERCURY_DYNAMIC_WORKFLOWS: '1',
  },
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
  const killer = setTimeout(() => child.kill('SIGKILL'), 120_000)
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
const launched = lines.find(l => l.ev === 'launched')
const settled = lines.find(l => l.ev === 'settled') as
  | { status?: string; legs?: Array<Record<string, unknown>>; logs?: string[] }
  | undefined

section('§1 the run completes; both agents settle done on the row')
check('child exited 0', status === 0, `status ${status}; stderr tail: ${errTail.slice(-400)}; lines: ${JSON.stringify(lines).slice(0, 600)}`)
check('workflow launched', !!launched, out.slice(0, 300))
check('workflow completed', settled?.status === 'completed', JSON.stringify(settled).slice(0, 600))
const legs = settled?.legs ?? []
check('two agent legs observed', legs.length === 2, `saw ${legs.length}`)
for (const leg of legs) {
  check(`leg #${leg.index} settled done on ${ID}`, leg.state === 'done' && String(leg.model ?? '') === ID, JSON.stringify(leg))
}

section("§2 per call: the request's reasoning.effort is the call's own word")
const responses = fixture.captured.filter(h => h.lane === 'responses')
check(`every seat request rode the Responses wire on ${ID}`, responses.length >= 2 && responses.every(h => h.model === ID), responses.map(h => h.model).join(','))
const promptOf = (body: Record<string, unknown>): string => {
  const input = body.input
  if (typeof input === 'string') return input
  if (!Array.isArray(input)) return ''
  let text = ''
  for (const item of input as Array<{ role?: string; content?: unknown }>) {
    if (item.role !== 'user') continue
    if (typeof item.content === 'string') text += `\n${item.content}`
    else if (Array.isArray(item.content)) {
      for (const block of item.content as Array<{ type?: string; text?: string }>) {
        if (typeof block.text === 'string') text += `\n${block.text}`
      }
    }
  }
  return text
}
for (const call of CALLS) {
  const mine = responses.filter(h => promptOf(h.body).includes(call.mark))
  const efforts = mine.map(h => String((h.body as { reasoning?: { effort?: unknown } }).reasoning?.effort ?? 'none'))
  check(`${call.mark}: every request carried reasoning.effort '${call.effort}' (${mine.length} requests)`, mine.length >= 1 && efforts.every(e => e === call.effort), efforts.join(','))
}
check('the two calls sent two different words (the ladder maps per call)', new Set(responses.map(h => String((h.body as { reasoning?: { effort?: unknown } }).reasoning?.effort))).size === 2, responses.map(h => String((h.body as { reasoning?: { effort?: unknown } }).reasoning?.effort)).join(','))

section('§3 the reasoning the wire streamed is captured in each record')
for (const leg of legs) {
  check(
    `leg #${leg.index}: reasoning captured (or counted unreadable — never silently absent)`,
    (typeof leg.readerReasoning === 'number' && (leg.readerReasoning as number) >= 1) ||
      (typeof leg.readerUnreadableReasoning === 'number' && (leg.readerUnreadableReasoning as number) >= 1),
    `reasoning=${leg.readerReasoning} unreadable=${leg.readerUnreadableReasoning}`,
  )
  check(`leg #${leg.index}: the final text landed`, String(leg.readerFinalText ?? '').includes(WF_FIXTURE_DONE('responses')), `finalText=${JSON.stringify(leg.readerFinalText)}`)
}

await fixture.close()
rmSync(scratch, { recursive: true, force: true })
console.log(failures ? `\n❌ GPT-6 ASTRA WORKFLOW EFFORTS RED (${failures} failing)` : '\n✅ GPT-6 ASTRA WORKFLOW EFFORTS GREEN')
process.exit(failures ? 1 : 0)
