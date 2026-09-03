#!/usr/bin/env bun
// ============================================================================
//  scripts/workflows/prove-model-switch-survival.ts
//  PROOF (workflow-hardening defect 2): a RUNNING workflow survives a /model
//  switch and a session rename. Only the operator's explicit stop (or the
//  workflow's own terminal state) ends a run.
//
//  The burn: Mercury's own diagnosis of the operator's failed evening run
//  read "the workflow was killed when the session model switched". Ruling:
//  that must never be possible. This prover launches a real workflow whose
//  one agent is held IN FLIGHT by fixture latency, then — mid-flight —
//  applies the REAL switch seams (/model = AppState.mainLoopModel +
//  setMainLoopModelOverride; /rename = saveCustomTitle + saveAgentName +
//  standaloneAgentContext), across provider FAMILY (claude → glm), and
//  asserts:
//    §1 the run COMPLETES (task + manifest terminal 'completed', never
//       killed), and the completion notification is delivered
//    §2 the in-flight agent kept its launch-time lane: the post-switch
//       tool-result turn still lands on the anthropic wire (a mid-run
//       switch must not silently reroute a running agent either)
//    §3 the switched state really was applied while the agent flew
//       (mainLoopModel read back mid-flight) — the survival was under a
//       REAL switch, not a no-op
//
//  Run:  ~/.bun/bin/bun run scripts/workflows/prove-model-switch-survival.ts
// ============================================================================
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWorkflowAgentFixture } from '../lib/workflowAgentFixture.ts'

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — model-switch survival prover exceeded 120s')
  process.exit(1)
}, 120_000)
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
const scratch = mkdtempSync(join(tmpdir(), 'wf-switch-'))

console.log('============================================================')
console.log(' Workflow survival — /model switch + rename under a live run')
console.log('============================================================')

// Each anthropic turn held 1200ms — two turns give a ~2.4s in-flight window.
const fixture = await startWorkflowAgentFixture({
  port: 34905,
  latencyMs: { anthropic: 1200 },
})

const CHILD = String.raw`
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
delete process.env.NODE_ENV
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'wf-switch-home-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
await import('${REPO}/src/tasks.js')
const { enableConfigs } = await import('${REPO}/src/utils/config/globalConfig.js')
enableConfigs()
const { WorkflowTool } = await import('${REPO}/src/tools/WorkflowTool/WorkflowTool.js')
const { getDefaultAppState } = await import('${REPO}/src/state/AppStateStore.js')
const { setMainLoopModelOverride, getSessionId } = await import('${REPO}/src/bootstrap/state.js')
const { saveCustomTitle, saveAgentName, getTranscriptPath } = await import('${REPO}/src/utils/sessionStorage.js')
const { getCommandQueueSnapshot } = await import('${REPO}/src/utils/messageQueueManager.js')
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
  toolUseId: 'switch-tool-use',
  readFileState: { readFileState: new Map(), clear: () => {} },
}

const script = [
  "export const meta = { name: 'switch-survival', description: 'survives a model switch' }",
  "const a = await agent('switch leg: run the echo command you are told to run, then reply done', {})",
  "return { a }",
].join('\n')

const res = await WorkflowTool.call({ script }, ctx, async () => ({ behavior: 'allow' }))
const d: any = (res as any).data
emit({ ev: 'launched', runId: d.runId })

// ── mid-flight: the REAL /model switch seams, across provider family ────────
await new Promise(r => setTimeout(r, 500))
setAppState((prev: any) => ({ ...prev, mainLoopModel: 'glm-5.3' }))
setMainLoopModelOverride('glm-5.3')
// …and the REAL /rename seams.
const sid = getSessionId() as any
await saveCustomTitle(sid, 'renamed-mid-run', getTranscriptPath())
await saveAgentName(sid, 'renamed-mid-run', getTranscriptPath())
setAppState((prev: any) => ({
  ...prev,
  standaloneAgentContext: { ...prev.standaloneAgentContext, name: 'renamed-mid-run' },
}))
const midFlight = {
  mainLoopModel: state.mainLoopModel,
  taskStatus: (Object.values(state.tasks ?? {})[0] as any)?.status,
}
emit({ ev: 'switched', ...midFlight })

// ── settle + verdict ────────────────────────────────────────────────────────
const deadline = Date.now() + 45_000
let task: any
for (;;) {
  task = Object.values(state.tasks ?? {}).find((t: any) => t.type === 'local_workflow')
  if (task && task.status !== 'running') break
  if (Date.now() > deadline) { emit({ ev: 'timeout', status: task?.status }); process.exit(1) }
  await new Promise(r => setTimeout(r, 80))
}
// THE CONTRACT IS THE NOTIFICATION: the task's live status flips first, the
// output file and run.json's terminal write follow, and the notification is
// enqueued LAST so whoever hears the run ended finds a run.json that agrees
// (WorkflowTool.tsx's completed path). A read at the status flip raced those
// writes on a loaded box (pool run 7) — settle on the notification, bounded.
const noteDeadline = Date.now() + 10_000
while (Date.now() < noteDeadline && !getCommandQueueSnapshot().some((c: any) => c.mode === 'task-notification' && String(c.value ?? '').includes(d.taskId))) {
  await new Promise(r => setTimeout(r, 50))
}
const manifest = JSON.parse(readFileSync(join(d.transcriptDir, 'run.json'), 'utf8'))
const agentFrames = (task.workflowProgress ?? []).filter((e: any) => e.type === 'workflow_agent')
// Task notifications are 'task-notification' rows in the ONE command queue
// (the steer-removal ruling retired the pen-facing snapshot alias).
const notes = getCommandQueueSnapshot()
  .filter((c: any) => c.mode === 'task-notification')
  .map((c: any) => String(c.value ?? ''))
  .filter(v => v.includes('task-notification') && v.includes(d.taskId))
emit({
  ev: 'settled',
  status: task.status,
  manifest: manifest.status,
  result: task.result,
  agentStates: agentFrames.map((f: any) => ({ state: f.state, model: f.model, toolCalls: f.toolCalls })),
  notes: notes.map(n => (n.match(/<status>(\w+)<\/status>/) ?? [])[1]),
})
process.exit(0)
`
writeFileSync(join(scratch, 'child.ts'), CHILD)

const child = spawn(BUN, ['run', join(scratch, 'child.ts')], {
  cwd: scratch,
  env: { ...process.env, ...fixture.env, MERCURY_DYNAMIC_WORKFLOWS: '1' },
})
let out = ''
let errTail = ''
child.stdout.on('data', (d: Buffer) => (out += d.toString()))
child.stderr.on('data', (d: Buffer) => (errTail = (errTail + d.toString()).slice(-1500)))
const status: number | null = await new Promise(resolve => {
  const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
  child.on('close', s => {
    clearTimeout(killer)
    resolve(s)
  })
})
const lines = out
  .split('\n')
  .filter(l => l.startsWith('@@'))
  .map(l => {
    try {
      return JSON.parse(l.slice(2)) as Record<string, unknown>
    } catch {
      return {}
    }
  })
const switched = lines.find(l => l.ev === 'switched')
const settled = lines.find(l => l.ev === 'settled') as
  | { status?: string; manifest?: string; agentStates?: Array<Record<string, unknown>>; notes?: string[]; result?: unknown }
  | undefined

section('§3 the switch really applied while the agent flew')
check('child exited 0', status === 0, `status ${status}; stderr: ${errTail.slice(-300)}; ${out.slice(0, 200)}`)
check('mid-flight state shows the FAMILY switch applied', switched?.mainLoopModel === 'glm-5.3', JSON.stringify(switched))
check('the workflow was still RUNNING at the switch instant', switched?.taskStatus === 'running', JSON.stringify(switched))

section('§1 the run survives to its own terminal state')
check('task settled completed (never killed)', settled?.status === 'completed', JSON.stringify(settled).slice(0, 300))
check('manifest terminal completed', settled?.manifest === 'completed')
check('completion notification delivered', (settled?.notes ?? []).includes('completed'), JSON.stringify(settled?.notes))
const agentStates = settled?.agentStates ?? []
check('the in-flight agent settled done with its tool call', agentStates.some(a => a.state === 'done' && (a.toolCalls as number) >= 1), JSON.stringify(agentStates))

section('§2 the running agent kept its launch-time lane')
const anthropicTurns = fixture.captured.filter(h => h.lane === 'anthropic')
check('two anthropic turns served (tool + final)', anthropicTurns.length >= 2, `saw ${anthropicTurns.length}`)
check('NO mid-run reroute to the switched family', fixture.captured.every(h => h.lane === 'anthropic' || h.path.startsWith('GET') || h.lane === 'other'), JSON.stringify(fixture.captured.map(h => h.lane)))

await fixture.close()
rmSync(scratch, { recursive: true, force: true })
console.log(failures ? `\n❌ MODEL-SWITCH SURVIVAL RED (${failures} failing)` : '\n✅ MODEL-SWITCH SURVIVAL GREEN')
process.exit(failures ? 1 : 0)
