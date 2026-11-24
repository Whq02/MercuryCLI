#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'capability-census-'))
const home = join(scratch, 'home')
const work = join(scratch, 'work')
mkdirSync(home, { recursive: true })
mkdirSync(work, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CONCOURSE_WORKER = '1'
delete process.env.MERCURY_EVAL_PYTHON

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const until = async (pred: () => boolean, ms: number): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (pred()) return true
    await sleep(40)
  }
  return pred()
}

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const census = await import('../../src/daemon/runner-link/runnerCapabilityCensus.ts')
const { evalKernelManager } = await import('../../src/tools/engines/eval-kernels/kernelManager.ts')
const services = await import('../../src/tools/engines/project-services/serviceManager.ts')

console.log('capability census — what a runner still holds that a park would lose')
try {
  console.log('C0 every tool has a declared and classified capability')
  const toolCensus = (await import('../../src/permissions/capability-census/census.ts')).buildToolCensus()
  const undeclared = toolCensus.rows.filter(row => row.declared === null).map(row => row.name)
  const unclassified = toolCensus.summary.unclassified
  check('the capability census has no undeclared and no unclassified tool', undeclared.length === 0 && unclassified.length === 0, `UNDECLARED: ${undeclared.join(', ') || 'none'} · UNCLASSIFIED: ${unclassified.join(', ') || 'none'} — declare and classify each listed tool in its capability contract; the rows come from buildToolCensus in src/permissions/capability-census/census.ts`)

  console.log('C1 an idle runner holds nothing')
  const idle = census.runnerCapabilityHolds({ pendingControlRequestCount: () => 0 })
  check('no kernel, browser, service, debug session or pending control request ⇒ no hold', idle.length === 0 && census.capabilityHoldWords(idle) === null, JSON.stringify(idle) + ' — runnerCapabilityHolds in src/daemon/runner-link/runnerCapabilityCensus.ts reports a hold with nothing live; find which add(...) source still counts')

  console.log('C2 a pending control request is a hold (in-memory, no process)')
  const pending = census.runnerCapabilityHolds({ pendingControlRequestCount: () => 2 })
  check('two pending control requests hold the park and are named', pending.length === 1 && pending[0]!.kind === 'pending control request' && pending[0]!.count === 2 && !pending[0]!.external && /2 pending control requests would not survive a park/.test(census.capabilityHoldWords(pending) ?? ''), JSON.stringify(pending) + ' — fix the pending control request hold and capabilityHoldWords in src/daemon/runner-link/runnerCapabilityCensus.ts')

  console.log('C3 a live eval kernel is a hold (a real child process)')
  const owner = 'census-owner'
  const cell = await evalKernelManager.runCell({ owner, cwd: work, input: { language: 'js', code: '1 + 1' }, abortSignal: new AbortController().signal, serveBridge: async () => ({ ok: false, error: 'no bridge here' }) })
  check('the cell ran on a kernel', cell.status === 'ok', JSON.stringify(cell).slice(0, 200) + ' — the eval cell did not run; look at runCell in src/tools/engines/eval-kernels/kernelManager.ts')
  const withKernel = census.runnerCapabilityHolds({ pendingControlRequestCount: () => 0 })
  check('the census names the kernel as an external hold', withKernel.some(h => h.kind === 'eval kernel' && h.count >= 1 && h.external), JSON.stringify(withKernel) + ' — runnerCapabilityHolds in src/daemon/runner-link/runnerCapabilityCensus.ts must add an external eval kernel hold from evalKernelManager.kernelCount()')
  check('the words say a live process would not survive', /eval kernel \(a live process\)/.test(census.capabilityHoldWords(withKernel) ?? ''), (census.capabilityHoldWords(withKernel) ?? '') + ' — capabilityHoldWords in src/daemon/runner-link/runnerCapabilityCensus.ts must word an external hold as (a live process)')
  await evalKernelManager.disposeOwner(owner)
  check('disposing the kernel clears the hold', await until(() => census.runnerCapabilityHolds({ pendingControlRequestCount: () => 0 }).length === 0, 5_000), JSON.stringify(census.runnerCapabilityHolds({ pendingControlRequestCount: () => 0 })) + ' — disposeOwner in src/tools/engines/eval-kernels/kernelManager.ts must drop the kernel so kernelCount() falls to 0')

  console.log('C4 a session-lifecycle service is a hold until it is stopped')
  const started = await services.startService({
    spec: { name: 'census-sleeper', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: work, readiness: [{ kind: 'stable', ms: 200 }], readinessMode: 'all', restart: 'never', lifecycle: 'session' },
    sessionId: 'census-session',
  })
  check('the service started', 'record' in started, JSON.stringify(started) + ' — startService in src/tools/engines/project-services/serviceManager.ts refused the service')
  const withService = census.runnerCapabilityHolds({ pendingControlRequestCount: () => 0 })
  check('the census names the service as an external hold with its pid', withService.some(h => h.kind === 'service' && h.count === 1 && h.external) && services.liveServiceChildren().every(c => typeof c.pid === 'number'), JSON.stringify({ withService, live: services.liveServiceChildren() }) + ' — runnerCapabilityHolds in src/daemon/runner-link/runnerCapabilityCensus.ts must count liveServiceChildren() as an external service hold, and each child needs a numeric pid')
  await services.stopService(work, 'census-sleeper')
  check('stopping the service clears the hold', await until(() => !census.runnerCapabilityHolds({ pendingControlRequestCount: () => 0 }).some(h => h.kind === 'service'), 10_000), JSON.stringify(census.runnerCapabilityHolds({ pendingControlRequestCount: () => 0 })) + ' — stopService in src/tools/engines/project-services/serviceManager.ts must remove the child from liveServiceChildren()')

  console.log('C4b a crewmate waiting to retry by itself holds the park, in a sentence of its own')
  {
    const lane = await import('../../src/engine/tasks/local-agent/crewmateTask.tsx')
    const utils = await import('../../src/tools/crewmate/crewmateLifecycle.ts')
    const { RunnerQuiescence } = await import('../../src/daemon/runner-link/runnerQuiescence.ts')
    const store = { state: { tasks: {} as Record<string, Record<string, unknown>>, speculation: { status: 'idle' }, crewmateNameRegistry: new Map() } }
    const set = ((update: (state: typeof store.state) => typeof store.state) => { store.state = update(store.state) }) as never
    const pausedAtAWall = (id: string): void => {
      const registered = lane.registerAsyncCrewmate({ agentId: id, description: id, prompt: 'work', setAppState: set })
      lane.failCrewmateTask(id, 'API Error: 429 the window is spent', set, registered.abortController)
      utils.armBudgetCutResume({ taskId: id, description: id, registration: registered.abortController!, toolUseContext: { options: { tools: [] } } as never, rootSetAppState: set, delayMs: 600_000, pause: { why: 'usage limit', words: 'the window is spent', resumesAtMs: Date.now() + 600_000 } })
    }
    const words = (pending = 0): string | null => census.capabilityHoldWords(census.runnerCapabilityHolds({ pendingControlRequestCount: () => pending }))
    check('nothing armed: no hold', words() === null, String(words()) + ' — a crewmate retry is still armed from an earlier step; armedAutomaticResumeCount in src/tools/crewmate/crewmateLifecycle.ts must return 0 once nothing is armed')
    pausedAtAWall('census-wall-1')
    const one = census.runnerCapabilityHolds({ pendingControlRequestCount: () => 0 })
    check('one crewmate paused at a usage wall with its retry armed is one hold, and its task row is not a running task', one.length === 1 && one[0]!.count === 1 && (store.state.tasks['census-wall-1'] as { status?: string }).status !== 'running', JSON.stringify({ one, status: (store.state.tasks['census-wall-1'] as { status?: string }).status }) + ' — armBudgetCutResume and failAgentTask must leave one armed retry that is not a running task; the count comes from waitingCrewmates in src/daemon/runner-link/runnerCapabilityCensus.ts')
    check("its words stand alone: what a park would lose is the retry, not the crewmate", words() === '1 crewmate is waiting to retry by itself', String(words()) + ' — waitingCrewmateWords in src/daemon/runner-link/runnerCapabilityCensus.ts words this hold')
    check('beside another hold the two are two sentences', words(1) === '1 pending control request would not survive a park; 1 crewmate is waiting to retry by itself', String(words(1)) + ' — capabilityHoldWords in src/daemon/runner-link/runnerCapabilityCensus.ts must join the lost holds sentence and the waiting-crewmate sentence with a semicolon')
    const quiescence = new RunnerQuiescence({ refusal: () => words(), flush: async () => {} })
    const refused = await quiescence.request({ subtype: 'quiesce', action: 'prepare', token: 'census-wall-token-0001' })
    check("the runner's fence refuses a park with that sentence", refused.ok === false && refused.reason === '1 crewmate is waiting to retry by itself', JSON.stringify(refused) + ' — RunnerQuiescence.request in src/daemon/runner-link/runnerQuiescence.ts must refuse prepare with the effects.refusal() sentence')
    pausedAtAWall('census-wall-2')
    check('two read in the plural', words() === '2 crewmates are waiting to retry by themselves', String(words()) + ' — waitingCrewmateWords in src/daemon/runner-link/runnerCapabilityCensus.ts must use the plural form for a count above one')
    utils.cancelAutomaticResume('census-wall-1')
    utils.cancelAutomaticResume('census-wall-2')
    const freed = await new RunnerQuiescence({ refusal: () => words(), flush: async () => {} }).request({ subtype: 'quiesce', action: 'prepare', token: 'census-wall-token-0002' })
    check('once nothing waits the hold is gone and the fence prepares', words() === null && freed.ok === true, JSON.stringify({ words: words(), freed }) + ' — cancelAutomaticResume in src/tools/crewmate/crewmateLifecycle.ts must disarm the retry so the hold lifts and RunnerQuiescence.request prepares')
  }

} catch (err) {
  failures++
  console.log(`  [FAIL] the proof threw: ${String(err)}`)
} finally {
  await evalKernelManager.disposeAll().catch(() => {})
  await services.stopService(work, 'census-sleeper').catch(() => {})
  rmSync(scratch, { recursive: true, force: true })
}
console.log(failures === 0 ? '\n CAPABILITY CENSUS — every live holder is named; a cleared holder lifts the hold' : `\n ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
