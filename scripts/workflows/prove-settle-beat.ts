#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — settle-beat prover exceeded 120s')
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
const scratch = mkdtempSync(join(tmpdir(), 'wf-beat-'))

console.log('============================================================')
console.log(' Workflow settlement — one beat: manifest → status → notification')
console.log('============================================================')

const CHILD = String.raw`
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
delete process.env.NODE_ENV
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'wf-beat-home-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
await import('${REPO}/src/tasks.js')
const { enableConfigs } = await import('${REPO}/src/utils/config/globalConfig.js')
enableConfigs()
const { WorkflowTool } = await import('${REPO}/src/tools/WorkflowTool/WorkflowTool.js')
const { getDefaultAppState } = await import('${REPO}/src/state/AppStateStore.js')
const { getCommandQueueSnapshot, resetCommandQueue } = await import('${REPO}/src/utils/messageQueueManager.js')
const emit = (o: unknown) => console.log('@@' + JSON.stringify(o))

const TERMINAL = new Set(['completed', 'completed_with_failures', 'failed', 'killed'])
const runDirByTask = new Map<string, string>()
const manifestStatus = (runDir: string): string => {
  try {
    return JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')).status
  } catch {
    return '(unreadable)'
  }
}
// The first observation of each fact per task, on one monotonic clock; the
// status flip also reads run.json synchronously — the reader's view at the
// instant the /workflows view changes its word.
type Seen = { statusAt?: number; status?: string; manifestAtFlip?: string; manifestAt?: number; noteAt?: number }
const seen = new Map<string, Seen>()
const seenFor = (taskId: string): Seen => {
  let s = seen.get(taskId)
  if (!s) {
    s = {}
    seen.set(taskId, s)
  }
  return s
}

let state: any = getDefaultAppState()
const setAppState = (fn: any) => {
  const prev = state
  state = typeof fn === 'function' ? fn(state) : fn
  for (const [taskId, task] of Object.entries(state.tasks ?? {}) as Array<[string, any]>) {
    const before = prev.tasks?.[taskId]?.status
    if (task.status === before || !TERMINAL.has(task.status)) continue
    const s = seenFor(taskId)
    if (s.statusAt !== undefined) continue
    s.statusAt = performance.now()
    s.status = task.status
    const runDir = runDirByTask.get(taskId)
    s.manifestAtFlip = runDir ? manifestStatus(runDir) : '(no run dir yet)'
  }
}
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
  toolUseId: 'beat-tool-use',
  readFileState: { readFileState: new Map(), clear: () => {} },
}

const notificationsFor = (taskId: string): string[] =>
  getCommandQueueSnapshot()
    .filter((c: any) => c.mode === 'task-notification')
    .map((c: any) => String(c.value ?? ''))
    .filter(v => v.includes('task-notification') && v.includes(taskId))

// Watch the three facts until all three have landed (or the deadline).
const watch = async (taskId: string, runDir: string, timeoutMs = 20000): Promise<Seen> => {
  const s = seenFor(taskId)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (s.manifestAt === undefined && TERMINAL.has(manifestStatus(runDir))) s.manifestAt = performance.now()
    if (s.noteAt === undefined && notificationsFor(taskId).length > 0) s.noteAt = performance.now()
    if (s.statusAt !== undefined && s.manifestAt !== undefined && s.noteAt !== undefined) return s
    if (Date.now() > deadline) return s
    await new Promise(r => setTimeout(r, 1))
  }
}
const launch = async (script: string) => {
  const res = await WorkflowTool.call({ script }, ctx, async () => ({ behavior: 'allow' }))
  const d = (res as any).data
  runDirByTask.set(d.taskId, d.transcriptDir)
  return d
}

{
  resetCommandQueue()
  const d = await launch("export const meta = { name: 'b-ok', description: 'completes' }\nlog('ok')\nreturn 'done-ok'")
  const s = await watch(d.taskId, d.transcriptDir)
  emit({ ev: 'leg', leg: 'completed', ...s, manifestFinal: manifestStatus(d.transcriptDir) })
}
{
  resetCommandQueue()
  const d = await launch("export const meta = { name: 'b-fail', description: 'fails' }\nthrow new Error('leg-failure')")
  const s = await watch(d.taskId, d.transcriptDir)
  emit({ ev: 'leg', leg: 'failed', ...s, manifestFinal: manifestStatus(d.transcriptDir) })
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
type Leg = { leg: string; statusAt?: number; status?: string; manifestAtFlip?: string; manifestAt?: number; noteAt?: number; manifestFinal?: string }
const legs = out
  .split('\n')
  .filter(l => l.startsWith('@@'))
  .map(l => {
    try {
      return JSON.parse(l.slice(2)) as Leg & { ev: string }
    } catch {
      return { ev: '', leg: '' } as Leg & { ev: string }
    }
  })
  .filter(l => l.ev === 'leg')

section('the two settlement roads')
check('child exited 0', status === 0, `status ${status}; stderr: ${errTail.slice(-300)}`)
check('two legs observed', legs.length === 2, `saw ${legs.length}: ${JSON.stringify(legs).slice(0, 300)}`)

const TERMINAL = new Set(['completed', 'completed_with_failures', 'failed'])
for (const name of ['completed', 'failed']) {
  const leg = legs.find(l => l.leg === name)
  section(`${name}: the manifest is terminal before the status flips, and the notification follows`)
  check(`${name}: the task settled ${name}`, leg?.status === name, JSON.stringify(leg))
  check(`${name}: run.json was already terminal AT the status flip (a reader never sees a finished status beside a running manifest)`, leg !== undefined && TERMINAL.has(leg.manifestAtFlip ?? ''), `run.json at the flip read ${JSON.stringify(leg?.manifestAtFlip)}`)
  check(`${name}: the notification landed after the status`, leg?.noteAt !== undefined && leg.statusAt !== undefined && leg.noteAt >= leg.statusAt, JSON.stringify(leg))
  check(`${name}: run.json settled ${name} in the end`, leg?.manifestFinal === name, JSON.stringify(leg?.manifestFinal))
}

if (failures === 0) rmSync(scratch, { recursive: true, force: true })
else console.log(`[forensics] scratch kept: ${scratch}`)
console.log(failures === 0 ? '\nprove-settle-beat: ALL LAWS HOLD' : `\nprove-settle-beat: ${failures} FAILURE(S)`)
clearTimeout(guard)
process.exit(failures === 0 ? 0 : 1)
