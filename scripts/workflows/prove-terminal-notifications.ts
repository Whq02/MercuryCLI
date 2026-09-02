#!/usr/bin/env bun
// ============================================================================
//  scripts/workflows/prove-terminal-notifications.ts
//  PROOF (workflow-hardening defect 3): EVERY terminal workflow state —
//  completed, failed, killed by the operator — delivers a
//  <task-notification> to the launching agent's turn, and paused (not
//  terminal) stays silent.
//
//  The burn (the operator's evening): a killed workflow never told the
//  agent that launched it — the launcher sat waiting on a corpse. Two
//  causes: killWorkflowTask pre-set the `notified` latch, and the run
//  loop's aborted branch returned after the manifest write without
//  enqueueing. Both fixed; this prover drives all four legs through the
//  REAL WorkflowTool.call + LocalWorkflowTask transitions (no model calls —
//  the scripts run pure) and reads the REAL pending-notification queue.
//
//  Run:  ~/.bun/bin/bun run scripts/workflows/prove-terminal-notifications.ts
// ============================================================================
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — terminal-notifications prover exceeded 120s')
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
const scratch = mkdtempSync(join(tmpdir(), 'wf-notify-'))

console.log('============================================================')
console.log(' Workflow terminal notifications — completed · failed · killed')
console.log('============================================================')

const CHILD = String.raw`
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
delete process.env.NODE_ENV
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'wf-notify-home-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
await import('${REPO}/src/tasks.js')
const { enableConfigs } = await import('${REPO}/src/utils/config/globalConfig.js')
enableConfigs()
const { WorkflowTool } = await import('${REPO}/src/tools/WorkflowTool/WorkflowTool.js')
const { getDefaultAppState } = await import('${REPO}/src/state/AppStateStore.js')
const { killWorkflowTask, pauseWorkflowTask } = await import('${REPO}/src/tasks/LocalWorkflowTask/LocalWorkflowTask.js')
// The pen-facing notification aliases died with the steer-removal ruling:
// task notifications are 'task-notification' rows in the ONE command queue.
const { getCommandQueueSnapshot, resetCommandQueue } = await import('${REPO}/src/utils/messageQueueManager.js')
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
  toolUseId: 'notify-tool-use',
  readFileState: { readFileState: new Map(), clear: () => {} },
}

const taskFor = (runId: string): any =>
  Object.values(state.tasks ?? {}).find((t: any) => t.type === 'local_workflow' && t.workflowRunId === runId)
const settleOf = async (runId: string, timeoutMs = 20000): Promise<any> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const t = taskFor(runId)
    if (t && t.status !== 'running') return t
    if (Date.now() > deadline) return t
    await new Promise(r => setTimeout(r, 50))
  }
}
const notificationsFor = (taskId: string): string[] =>
  getCommandQueueSnapshot()
    .filter((c: any) => c.mode === 'task-notification')
    .map((c: any) => String(c.value ?? ''))
    .filter(v => v.includes('task-notification') && v.includes(taskId))
const waitNotification = async (taskId: string, timeoutMs = 8000): Promise<string[]> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hits = notificationsFor(taskId)
    if (hits.length > 0) return hits
    if (Date.now() > deadline) return hits
    await new Promise(r => setTimeout(r, 50))
  }
}
const launch = async (script: string) => {
  const res = await WorkflowTool.call({ script }, ctx, async () => ({ behavior: 'allow' }))
  return (res as any).data
}
const manifestStatus = (runDir: string): string => {
  try {
    return JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')).status
  } catch {
    return '(unreadable)'
  }
}

// ── leg 1: completed ─────────────────────────────────────────────────────────
{
  resetCommandQueue()
  const d = await launch("export const meta = { name: 'n-ok', description: 'completes' }\nlog('ok')\nreturn 'done-ok'")
  const t = await settleOf(d.runId)
  const notes = await waitNotification(d.taskId)
  emit({ ev: 'leg', leg: 'completed', task: t?.status, manifest: manifestStatus(d.transcriptDir), notes, notified: t?.notified })
}
// ── leg 2: failed ────────────────────────────────────────────────────────────
{
  resetCommandQueue()
  const d = await launch("export const meta = { name: 'n-fail', description: 'fails' }\nthrow new Error('leg-failure')")
  const t = await settleOf(d.runId)
  const notes = await waitNotification(d.taskId)
  emit({ ev: 'leg', leg: 'failed', task: t?.status, manifest: manifestStatus(d.transcriptDir), notes })
}
// ── leg 3: killed by the operator ────────────────────────────────────────────
{
  resetCommandQueue()
  const d = await launch("export const meta = { name: 'n-hang', description: 'hangs' }\nlog('hanging')\nawait new Promise(() => {})\nreturn 'unreachable'")
  await new Promise(r => setTimeout(r, 300))
  const receipt = killWorkflowTask(d.taskId, setAppState)
  const t = await settleOf(d.runId)
  const notes = await waitNotification(d.taskId)
  emit({ ev: 'leg', leg: 'killed', receipt, task: t?.status, manifest: manifestStatus(d.transcriptDir), notes })
}
// ── leg 4: paused stays silent (not terminal) ────────────────────────────────
{
  resetCommandQueue()
  const d = await launch("export const meta = { name: 'n-pause', description: 'hangs for pause' }\nlog('hanging')\nawait new Promise(() => {})\nreturn 'unreachable'")
  await new Promise(r => setTimeout(r, 300))
  const receipt = pauseWorkflowTask(d.taskId, setAppState)
  const t = await settleOf(d.runId)
  // Give a wrong implementation a beat to (incorrectly) notify.
  await new Promise(r => setTimeout(r, 1200))
  const notes = notificationsFor(d.taskId)
  emit({ ev: 'leg', leg: 'paused', receipt, task: t?.status, manifest: manifestStatus(d.transcriptDir), notes })
}
process.exit(0)
`
writeFileSync(join(scratch, 'child.ts'), CHILD)

const child = spawn(BUN, ['run', join(scratch, 'child.ts')], {
  cwd: scratch,
  env: { ...process.env, MERCURY_DYNAMIC_WORKFLOWS: '1' },
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
const legs = out
  .split('\n')
  .filter(l => l.startsWith('@@'))
  .map(l => {
    try {
      return JSON.parse(l.slice(2)) as Record<string, unknown>
    } catch {
      return {}
    }
  })
  .filter(l => l.ev === 'leg')

section('the four legs')
check('child exited 0', status === 0, `status ${status}; stderr: ${errTail.slice(-300)}`)
check('four legs observed', legs.length === 4, `saw ${legs.length}: ${JSON.stringify(legs).slice(0, 300)}`)

const legOf = (name: string): Record<string, unknown> | undefined => legs.find(l => l.leg === name)

section('completed: notification delivered, status truthful')
const completed = legOf('completed')
if (completed) {
  check('task settled completed', completed.task === 'completed')
  check('manifest terminal completed', completed.manifest === 'completed')
  const notes = (completed.notes as string[]) ?? []
  check('ONE task-notification delivered', notes.length === 1, JSON.stringify(notes).slice(0, 200))
  check('notification says completed', notes.some(n => n.includes('<status>completed</status>')))
}

section('failed: notification delivered, error named')
const failed = legOf('failed')
if (failed) {
  check('task settled failed', failed.task === 'failed')
  check('manifest terminal failed', failed.manifest === 'failed')
  const notes = (failed.notes as string[]) ?? []
  check('ONE task-notification delivered', notes.length === 1, JSON.stringify(notes).slice(0, 200))
  check('notification says failed + names the error', notes.some(n => n.includes('<status>failed</status>') && n.includes('leg-failure')))
}

section('killed: the launcher is told (the corpse-wait fix)')
const killed = legOf('killed')
if (killed) {
  check('kill receipt applied', killed.receipt === 'applied')
  check('task settled killed', killed.task === 'killed')
  check('manifest terminal killed', killed.manifest === 'killed', String(killed.manifest))
  const notes = (killed.notes as string[]) ?? []
  check('ONE task-notification delivered', notes.length === 1, JSON.stringify(notes).slice(0, 300))
  check('notification says killed ("was stopped")', notes.some(n => n.includes('<status>killed</status>') && n.includes('was stopped')))
  check('recovery section points at the resume call', notes.some(n => n.includes('<recovery>') && n.includes('resumeFromRunId')))
}

section('paused: NOT terminal — stays silent')
const paused = legOf('paused')
if (paused) {
  check('pause receipt applied', paused.receipt === 'applied')
  check('task paused', paused.task === 'paused')
  check('manifest paused', paused.manifest === 'paused', String(paused.manifest))
  const notes = (paused.notes as string[]) ?? []
  check('NO notification for a pause', notes.length === 0, JSON.stringify(notes).slice(0, 200))
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures ? `\n❌ TERMINAL-NOTIFICATIONS RED (${failures} failing)` : '\n✅ TERMINAL-NOTIFICATIONS GREEN')
process.exit(failures ? 1 : 0)
