#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

delete process.env.NODE_ENV
delete process.env.MERCURY_EVAL_PYTHON
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_DESKTOP_DRIVER = 'none'
process.env.MERCURY_BROWSER_PATH = process.execPath
process.env.MERCURY_BROWSER ??= '1'

const posix = process.platform !== 'win32'
const home = process.env.MERCURY_CONFIG_DIR!
const work = join(home, 'work')
mkdirSync(work, { recursive: true })

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const alive = (pid: number | null | undefined): boolean => {
  if (!pid) return false
  try {
    process.kill(pid, 0)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
  if (!posix) return true
  try {
    return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim().startsWith('Z')
  } catch {
    return false
  }
}
const goneSoon = async (pid: number | null | undefined, ms = 3_000): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await sleep(50)
  }
  return !alive(pid)
}
const within = <T>(label: string, ms: number, work: Promise<T>): Promise<T> =>
  Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms))])

console.log("crewmate-teardown: a crewmate's processes die with it — the Bash tool's seam (runAgent's finally) given to every tool that starts something")

const lifecycle = (await import('../../src/engine/run-owner/ownerLifecycle.ts')) as Record<string, unknown> & typeof import('../../src/engine/run-owner/ownerLifecycle.ts')
const { processOwnerForLane } = await import('../../src/engine/run-owner/resolveOwner.ts')
const disposeOwnerProcesses = (lifecycle.disposeOwnerProcesses ?? (async () => undefined)) as (owner: import('../../src/engine/run-owner/ownerKey.ts').OwnerKey) => Promise<void>
const CREW = processOwnerForLane('agent-crew-teardown')
const SEAT = processOwnerForLane(null)

section('§1 THE SEAM — the run\'s finally ends the lane\'s live processes beside its shells; the live stores say so')
{
  check('ownerLifecycle exports disposeOwnerProcesses', typeof lifecycle.disposeOwnerProcesses === 'function', 'export disposeOwnerProcesses from src/engine/run-owner/ownerLifecycle.ts; runAgent in src/tools/crewmate/runCrewmate.ts calls it in its finally')
}

section('§2 EVAL — the crewmate\'s kernel and the children its cells spawned are gone; the seat\'s kernel stays')
const { evalKernelManager } = await import('../../src/tools/engines/eval-kernels/kernelManager.ts')
if (posix) {
  const bridge: import('../../src/tools/engines/eval-kernels/kernelManager.ts').BridgeServer = async () => ({ ok: false, error: 'no bridge in this prover' })
  const run = (owner: string, code: string) => within('js cell', 60_000, evalKernelManager.runCell({ owner, cwd: work, input: { language: 'js', code }, abortSignal: new AbortController().signal, serveBridge: bridge }))
  const crewCell = await run(String(CREW), "const c = require('node:child_process').spawn('sleep', ['300'], { stdio: 'ignore' }); JSON.stringify({ kernel: process.pid, child: c.pid })")
  const seatCell = await run(String(SEAT), 'JSON.stringify({ kernel: process.pid })')
  const pids = (cell: { status: string; value?: unknown; result?: unknown }): { kernel?: number; child?: number } => {
    const text = JSON.stringify(cell)
    const m = /\{\\"kernel\\":(\d+)(?:,\\"child\\":(\d+))?\}/.exec(text) ?? /\{"kernel":(\d+)(?:,"child":(\d+))?\}/.exec(text)
    return m ? { kernel: Number(m[1]), ...(m[2] ? { child: Number(m[2]) } : {}) } : {}
  }
  const crew = pids(crewCell as never)
  const seat = pids(seatCell as never)
  check('the crewmate\'s cell ran and named its kernel and its child', crewCell.status === 'ok' && crew.kernel !== undefined && crew.child !== undefined, JSON.stringify(crewCell).slice(0, 300) + ' | the js cell must run and return its kernel and child pids; look at runCell in src/tools/engines/eval-kernels/kernelManager.ts')
  check('the seat\'s cell ran', seatCell.status === 'ok' && seat.kernel !== undefined, JSON.stringify(seatCell).slice(0, 200) + ' | the js cell must run and return its kernel pid; look at runCell in src/tools/engines/eval-kernels/kernelManager.ts')
  check('two kernels live before the crewmate ends', evalKernelManager.kernelCount() === 2 && alive(crew.kernel) && alive(crew.child) && alive(seat.kernel), `count=${evalKernelManager.kernelCount()} | each owner needs its own live kernel; look at runCell in src/tools/engines/eval-kernels/kernelManager.ts`)
  await disposeOwnerProcesses(CREW)
  check('the crewmate\'s kernel row is gone and the seat\'s stays', evalKernelManager.kernelCount() === 1, `count=${evalKernelManager.kernelCount()} | the owner-scoped store registered in src/tools/engines/eval-kernels/kernelManager.ts must drop the crewmate's kernel when disposeOwnerProcesses runs`)
  check(`the crewmate's kernel process is gone (pid ${crew.kernel})`, await goneSoon(crew.kernel), 'the kernel store in src/tools/engines/eval-kernels/kernelManager.ts must kill the crewmate kernel process when disposeOwnerProcesses runs')
  check(`the child its cell spawned is gone too (pid ${crew.child}) — the kernel led its own group`, await goneSoon(crew.child), 'the kernel in src/tools/engines/eval-kernels/kernelManager.ts must start in its own process group and be killed as a group, so the cell children die with it')
  check(`the seat's kernel is still alive (pid ${seat.kernel})`, alive(seat.kernel), 'disposing one owner in src/tools/engines/eval-kernels/kernelManager.ts must leave other owners kernels running')
  await evalKernelManager.disposeAll()
  check('cleanup: every kernel disposed', evalKernelManager.kernelCount() === 0 && (await goneSoon(seat.kernel)))
  if (crew.child && alive(crew.child)) process.kill(crew.child, 'SIGKILL')
} else {
  console.log('  [SKIP] the js kernel leg spawns `sleep` from its cell, a POSIX shape on this host (the win32 arm rides the field task)')
}

section('§3 SERVICE — the session-lifecycle services the crewmate started stop at its end; a project-lifecycle one and the seat\'s stay')
const services = await import('../../src/tools/engines/project-services/serviceManager.ts')
if (posix) {
  const spec = (name: string, lifecycle: 'session' | 'project') => ({ name, command: 'sleep', args: ['300'], cwd: work, readiness: [], readinessMode: 'all' as const, restart: 'never' as const, lifecycle })
  const crewSession = await services.startService({ spec: spec('crew-session', 'session'), sessionId: 'proof', owner: CREW } as never)
  const crewProject = await services.startService({ spec: spec('crew-project', 'project'), sessionId: 'proof', owner: CREW } as never)
  const seatSession = await services.startService({ spec: spec('seat-session', 'session'), sessionId: 'proof', owner: SEAT } as never)
  const pidOf = (r: unknown): number | null => ('record' in (r as object) ? (r as { record: { pid: number | null } }).record.pid : null)
  check('three services started', pidOf(crewSession) !== null && pidOf(crewProject) !== null && pidOf(seatSession) !== null, JSON.stringify([crewSession, crewProject, seatSession]).slice(0, 300) + ' | startService in src/tools/engines/project-services/serviceManager.ts must return a record with a pid')
  check('the live store counts the two session-lifecycle rows', lifecycle.ownerLifecycleCounts().stores['project-services'] === 2, JSON.stringify(lifecycle.ownerLifecycleCounts().stores) + ' | startService in src/tools/engines/project-services/serviceManager.ts must count only session-lifecycle rows in its owner-scoped store')
  await disposeOwnerProcesses(CREW)
  const after = services.reconcileRecord(work, 'crew-session')
  check('the crewmate\'s session service record reads stopped with no pid', after?.state === 'stopped' && after.pid === null, JSON.stringify(after) + ' | the store registered in src/tools/engines/project-services/serviceManager.ts must stop the crewmate session services and clear their pid when disposeOwnerProcesses runs')
  check(`its process is gone (pid ${pidOf(crewSession)})`, await goneSoon(pidOf(crewSession)), 'the store registered in src/tools/engines/project-services/serviceManager.ts must kill the session service process when disposeOwnerProcesses runs')
  check('the registry holds no row for the crewmate', lifecycle.ownerLifecycleCounts().stores['project-services'] === 1, 'the store in src/tools/engines/project-services/serviceManager.ts must drop the crewmate session row and keep the rest')
  check(`the crewmate's project-lifecycle service survives, by its own word (pid ${pidOf(crewProject)})`, alive(pidOf(crewProject)) && services.reconcileRecord(work, 'crew-project')?.state !== 'stopped', 'the store in src/tools/engines/project-services/serviceManager.ts must not stop a project-lifecycle service when the owner ends')
  check(`the seat's session service survives (pid ${pidOf(seatSession)})`, alive(pidOf(seatSession)), 'the store in src/tools/engines/project-services/serviceManager.ts must only touch the disposed owner services')
  for (const name of ['crew-project', 'seat-session', 'crew-session']) await services.stopService(work, name)
  check('cleanup: the other two stopped', (await goneSoon(pidOf(crewProject))) && (await goneSoon(pidOf(seatSession))))
} else {
  console.log('  [SKIP] the service leg is POSIX-shaped on this host (sleep)')
}

section('§4 JOURNEY — a journey kept with cleanup: keep leaves its services to the lane; the lane\'s end stops them')
const journeys = await import('../../src/tools/engines/journeys/runner.ts')
if (posix) {
  const record = await within('journey', 30_000, journeys.runJourney({ objective: 'keep a fixture service', steps: [{ kind: 'service.start', name: 'jy-kept', command: 'sleep', args: ['300'] }], cleanup: 'keep' } as never, { owner: CREW, root: work }))
  const kept = services.reconcileRecord(work, 'jy-kept')
  check('the journey kept its service running', record.state === 'succeeded' && kept !== null && alive(kept.pid), JSON.stringify({ state: record.state, pid: kept?.pid }) + ' | runJourney in src/tools/engines/journeys/runner.ts must succeed and leave a service.start step running when cleanup is keep')
  await disposeOwnerProcesses(CREW)
  check('the kept service stopped at the lane\'s end', services.reconcileRecord(work, 'jy-kept')?.state === 'stopped' && (await goneSoon(kept?.pid)), 'the service store in src/tools/engines/project-services/serviceManager.ts must stop services a journey kept when the owner lane ends')
  check('the journey\'s own record (a fact) stays until the owner goes', journeys.listJourneys(CREW).length === 1, 'the store in src/tools/engines/journeys/runner.ts must keep journey records after disposeOwnerProcesses; only disposeOwner may drop them')
  await services.stopService(work, 'jy-kept')
} else {
  console.log('  [SKIP] the journey leg is POSIX-shaped on this host (sleep)')
}

section('§5 MONITOR — a watch rides the shell task registry with the crewmate\'s id; the Bash seam ends it')
const { spawnShellTask } = await import('../../src/engine/tasks/local-shell/shellTask.tsx')
const { killShellTasksForCrewmate } = await import('../../src/engine/tasks/local-shell/killShellTasks.ts')
const { wrapSpawn } = await import('../../src/platform/shell/shellProcess.ts')
const { TaskOutput } = await import('../../src/engine/task-framework/taskOutput.ts')
const { generateTaskId } = await import('../../src/engine/tasks/taskBase.ts')
if (posix) {
  const child = spawn('sleep', ['300'], { stdio: 'ignore' })
  const cmd = wrapSpawn(child, new AbortController().signal, 60_000, new TaskOutput(generateTaskId('local_bash'), null))
  let state: { tasks: Record<string, { status: string; agentId?: string; kind?: string }> } = { tasks: {} }
  const setAppState = (f: (prev: typeof state) => typeof state): void => {
    state = f(state)
  }
  const handle = await spawnShellTask({ command: 'sleep 300', description: 'crewmate watch', shellCommand: cmd, agentId: 'agent-crew-teardown', kind: 'monitor' } as never, { abortController: new AbortController(), getAppState: () => state, setAppState } as never)
  check('the monitor task is running under the crewmate\'s id', state.tasks[handle.taskId]?.status === 'running' && state.tasks[handle.taskId]?.agentId === 'agent-crew-teardown' && state.tasks[handle.taskId]?.kind === 'monitor', JSON.stringify(state.tasks[handle.taskId]) + ' | spawnShellTask in src/engine/tasks/local-shell/shellTask.tsx must register the task as running with the agentId and kind it was given')
  killShellTasksForCrewmate('agent-crew-teardown', () => state as never, setAppState as never)
  check('the task reads killed at once', state.tasks[handle.taskId]?.status === 'killed', 'killShellTasksForAgent in src/engine/tasks/local-shell/killShellTasks.ts must mark every running task of that agent killed')
  const receipt = await Promise.race([(cmd as unknown as { treeKillReceipt?: Promise<unknown> }).treeKillReceipt ?? Promise.resolve('no receipt'), sleep(5_000).then(() => 'receipt pending after 5s')])
  const watchGone = await goneSoon(child.pid)
  const row = (): string => {
    try {
      return execFileSync('ps', ['-o', 'pid=,ppid=,pgid=,stat=,command=', '-p', String(child.pid)], { encoding: 'utf8' }).trim()
    } catch {
      return 'no row'
    }
  }
  check(`the watch's process is gone (pid ${child.pid}); the stop's tree receipt: ${JSON.stringify(receipt)}`, watchGone, row() + ' | killShellTasksForAgent in src/engine/tasks/local-shell/killShellTasks.ts must tree-kill the watch process')
} else {
  console.log('  [SKIP] the monitor leg is POSIX-shaped on this host (sleep)')
}

section('§6 DEBUG — an adapter registered under the lane (the dap:<id> road) is disposed at the lane\'s end')
{
  let disposed = 0
  lifecycle.registerOwnerDisposer(CREW, 'dap:fixture', async () => {
    disposed += 1
  })
  lifecycle.registerOwnerDisposer(SEAT, 'dap:seat', async () => undefined)
  const before = lifecycle.ownerLifecycleCounts().adhoc
  await disposeOwnerProcesses(CREW)
  check('the crewmate\'s adapter disposer ran once', disposed === 1, 'disposeOwnerProcesses in src/engine/run-owner/ownerLifecycle.ts must run each disposer registered with registerOwnerDisposer for that owner exactly once')
  check('the seat\'s adapter row stays', lifecycle.ownerLifecycleCounts().adhoc === before - 1, `${before} → ${lifecycle.ownerLifecycleCounts().adhoc} | disposeOwnerProcesses in src/engine/run-owner/ownerLifecycle.ts must drop only the disposed owner disposer rows`)
  lifecycle.unregisterOwnerDisposer(SEAT, 'dap:seat')
}

section('§7 BROWSER — the crewmate\'s browser child is closed and its grants dropped at the lane\'s end')
{
  const browser = await import('../../src/integrations/browser/browserSession.ts')
  let closed = 0
  const fixture = {
    connected: true,
    process: () => ({ pid: 900_001, exitCode: null, signalCode: null, kill: () => undefined }),
    pages: async () => [{ url: () => 'about:blank', on: () => undefined, viewport: () => ({ width: 1280, height: 800 }), close: async () => undefined, title: async () => 'fixture', frames: () => [] }],
    newPage: async () => ({ url: () => 'about:blank', on: () => undefined, viewport: () => ({ width: 1280, height: 800 }), close: async () => undefined, title: async () => 'fixture', frames: () => [] }),
    on: () => fixture,
    once: () => fixture,
    off: () => fixture,
    close: async () => {
      closed += 1
      fixture.connected = false
    },
  }
  browser.setBrowserLaunchDriverForProof(async () => fixture as never)
  const opened = await browser.ensureBrowserSession(CREW)
  check('the crewmate\'s browser session is live', !('state' in opened) && browser.activeSession(CREW) !== null, JSON.stringify(opened).slice(0, 200) + ' | ensureBrowserSession in src/integrations/browser/browserSession.ts must open a session through the proof launch driver')
  browser.approveWebOrigin(CREW, 'https://example.test/path')
  await disposeOwnerProcesses(CREW)
  check('the browser child was closed once', closed === 1, 'the owner store in src/integrations/browser/session/owners.ts must close the browser child when disposeOwnerProcesses runs')
  check('the lane has no session and no grants', browser.activeSession(CREW) === null && browser.approvedOriginList(CREW).length === 0 && !browser.liveBrowserSessionCensus().some(row => row.owner === CREW), 'the owner store in src/integrations/browser/session/owners.ts must drop the session and approved origins when disposeOwnerProcesses runs')
  browser.setBrowserLaunchDriverForProof(null)
}

section('§8 THE FACTS STAY — the lane\'s evidence survives its processes\' end and goes only with the owner')
{
  const evidence = await import('../../src/engine/runtime-kernel/evidencePlane.ts')
  const before = evidence.evidenceFor(CREW).length
  evidence.recordCanonicalEvidence({ owner: CREW, kind: 'check', origin: 'observed', claim: 'the crewmate observed a fact' })
  await disposeOwnerProcesses(CREW)
  check('the evidence rows are still there after the processes ended (the hand-back reads them)', evidence.evidenceFor(CREW).length === before + 1 && before + 1 > 0, `${before} → ${evidence.evidenceFor(CREW).length} | disposeOwnerProcesses in src/engine/run-owner/ownerLifecycle.ts must skip the evidence store in src/engine/runtime-kernel/evidencePlane.ts (a store without live: true)`)
  await lifecycle.disposeOwner(CREW)
  check('disposeOwner (session close) takes it with the owner', evidence.evidenceFor(CREW).length === 0, 'disposeOwner in src/engine/run-owner/ownerLifecycle.ts must dispose every store, including src/engine/runtime-kernel/evidencePlane.ts')
}

section('§9 THE WIN32 ARM — the strikes the Windows box re-checks live')
{
  const { win32TaskkillCommand } = await import('../../src/platform/processes/processGroup.ts')
  check('the tree kill is taskkill /PID <pid> /T /F through an argv array', win32TaskkillCommand(4242).args.join(' ') === '/PID 4242 /T /F', 'win32TaskkillCommand in src/platform/processes/processGroup.ts must return args /PID <pid> /T /F')
}

section('§10 THE QUIT ROAD — the session\'s own cleanup ends session-lifecycle services and leaves a project-lifecycle one alive, as the Service tool promises')
if (posix) {
  const spec = (name: string, lifecycle: 'session' | 'project') => ({ name, command: 'sleep', args: ['300'], cwd: work, readiness: [], readinessMode: 'all' as const, restart: 'never' as const, lifecycle })
  const quitSession = await services.startService({ spec: spec('quit-session', 'session'), sessionId: 'proof', owner: SEAT } as never)
  const quitProject = await services.startService({ spec: spec('quit-project', 'project'), sessionId: 'proof', owner: SEAT } as never)
  const pidOf = (r: unknown): number | null => ('record' in (r as object) ? (r as { record: { pid: number | null } }).record.pid : null)
  check('a session-lifecycle and a project-lifecycle service are up', alive(pidOf(quitSession)) && alive(pidOf(quitProject)), 'startService in src/tools/engines/project-services/serviceManager.ts must leave both services running')
  const { runCleanupFunctions } = await import('../../src/platform/processes/cleanupRegistry.ts')
  await runCleanupFunctions().catch(() => undefined)
  check(`the quit ended the session-lifecycle service (pid ${pidOf(quitSession)})`, await goneSoon(pidOf(quitSession)), 'the cleanup registered by src/engine/run-owner/ownerLifecycle.ts through runCleanupFunctions (src/platform/processes/cleanupRegistry.ts) must stop session-lifecycle services')
  check(`the quit left the project-lifecycle service alive (pid ${pidOf(quitProject)}) — "project = detached, survives it"`, alive(pidOf(quitProject)), 'the shutdown path in src/tools/engines/project-services/serviceManager.ts must not kill a project-lifecycle service')
  await services.stopService(work, 'quit-project')
  check('cleanup: the project service stopped by hand', await goneSoon(pidOf(quitProject)))
} else {
  console.log('  [SKIP] the quit leg is POSIX-shaped on this host (sleep)')
}

console.log(`\ncrewmate-teardown: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
