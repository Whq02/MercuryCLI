#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const census = await import('../../src/daemon/runnerCapabilityCensus.ts')
const { evalKernelManager } = await import('../../src/services/eval/kernelManager.ts')
const services = await import('../../src/services/projectServices/serviceManager.ts')
const REPO = join(import.meta.dir, '..', '..')
const src = (p: string): string => readFileSync(join(REPO, p), 'utf8')

console.log('capability census — what a runner still holds that a park would lose')
try {
  console.log('C0 every tool has a declared and classified capability')
  const toolCensus = (await import('../../src/utils/capability/census.ts')).buildToolCensus()
  const undeclared = toolCensus.rows.filter(row => row.declared === null).map(row => row.name)
  const unclassified = toolCensus.summary.unclassified
  check('the capability census has no undeclared and no unclassified tool', undeclared.length === 0 && unclassified.length === 0, `UNDECLARED: ${undeclared.join(', ') || 'none'} · UNCLASSIFIED: ${unclassified.join(', ') || 'none'}`)

  console.log('C1 an idle runner holds nothing')
  const idle = census.runnerCapabilityHolds({ pendingControlRequestCount: () => 0 })
  check('no kernel, browser, service, debug session or pending control request ⇒ no hold', idle.length === 0 && census.capabilityHoldWords(idle) === null, JSON.stringify(idle))

  console.log('C2 a pending control request is a hold (in-memory, no process)')
  const pending = census.runnerCapabilityHolds({ pendingControlRequestCount: () => 2 })
  check('two pending control requests hold the park and are named', pending.length === 1 && pending[0]!.kind === 'pending control request' && pending[0]!.count === 2 && !pending[0]!.external && /2 pending control requests would not survive a park/.test(census.capabilityHoldWords(pending) ?? ''), JSON.stringify(pending))

  console.log('C3 a live eval kernel is a hold (a real child process)')
  const owner = 'census-owner'
  const cell = await evalKernelManager.runCell({ owner, cwd: work, input: { language: 'js', code: '1 + 1' }, abortSignal: new AbortController().signal, serveBridge: async () => ({ ok: false, error: 'no bridge here' }) })
  check('the cell ran on a kernel', cell.status === 'ok', JSON.stringify(cell).slice(0, 200))
  const withKernel = census.runnerCapabilityHolds({ pendingControlRequestCount: () => 0 })
  check('the census names the kernel as an external hold', withKernel.some(h => h.kind === 'eval kernel' && h.count >= 1 && h.external), JSON.stringify(withKernel))
  check('the words say a live process would not survive', /eval kernel \(a live process\)/.test(census.capabilityHoldWords(withKernel) ?? ''), census.capabilityHoldWords(withKernel) ?? '')
  await evalKernelManager.disposeOwner(owner)
  check('disposing the kernel clears the hold', await until(() => census.runnerCapabilityHolds({ pendingControlRequestCount: () => 0 }).length === 0, 5_000), JSON.stringify(census.runnerCapabilityHolds({ pendingControlRequestCount: () => 0 })))

  console.log('C4 a session-lifecycle service is a hold until it is stopped')
  const started = await services.startService({
    spec: { name: 'census-sleeper', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: work, readiness: [{ kind: 'stable', ms: 200 }], readinessMode: 'all', restart: 'never', lifecycle: 'session' },
    sessionId: 'census-session',
  })
  check('the service started', 'record' in started, JSON.stringify(started))
  const withService = census.runnerCapabilityHolds({ pendingControlRequestCount: () => 0 })
  check('the census names the service as an external hold with its pid', withService.some(h => h.kind === 'service' && h.count === 1 && h.external) && services.liveServiceChildren().every(c => typeof c.pid === 'number'), JSON.stringify({ withService, live: services.liveServiceChildren() }))
  await services.stopService(work, 'census-sleeper')
  check('stopping the service clears the hold', await until(() => !census.runnerCapabilityHolds({ pendingControlRequestCount: () => 0 }).some(h => h.kind === 'service'), 10_000), JSON.stringify(census.runnerCapabilityHolds({ pendingControlRequestCount: () => 0 })))

  console.log('C4b a crewmate waiting to retry by itself holds the park, in a sentence of its own')
  {
    const lane = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.tsx')
    const utils = await import('../../src/tools/AgentTool/agentToolUtils.ts')
    const { RunnerQuiescence } = await import('../../src/daemon/runnerQuiescence.ts')
    const store = { state: { tasks: {} as Record<string, Record<string, unknown>>, speculation: { status: 'idle' }, agentNameRegistry: new Map() } }
    const set = ((update: (state: typeof store.state) => typeof store.state) => { store.state = update(store.state) }) as never
    const pausedAtAWall = (id: string): void => {
      const registered = lane.registerAsyncAgent({ agentId: id, description: id, prompt: 'work', setAppState: set })
      lane.failAgentTask(id, 'API Error: 429 the window is spent', set, registered.abortController)
      utils.armBudgetCutResume({ taskId: id, description: id, registration: registered.abortController!, toolUseContext: { options: { tools: [] } } as never, rootSetAppState: set, delayMs: 600_000, pause: { why: 'usage limit', words: 'the window is spent', resumesAtMs: Date.now() + 600_000 } })
    }
    const words = (pending = 0): string | null => census.capabilityHoldWords(census.runnerCapabilityHolds({ pendingControlRequestCount: () => pending }))
    check('nothing armed: no hold', words() === null, String(words()))
    pausedAtAWall('census-wall-1')
    const one = census.runnerCapabilityHolds({ pendingControlRequestCount: () => 0 })
    check('one crewmate paused at a usage wall with its retry armed is one hold, and its task row is not a running task', one.length === 1 && one[0]!.count === 1 && (store.state.tasks['census-wall-1'] as { status?: string }).status !== 'running', JSON.stringify({ one, status: (store.state.tasks['census-wall-1'] as { status?: string }).status }))
    check("its words stand alone: what a park would lose is the retry, not the crewmate", words() === '1 crewmate is waiting to retry by itself', String(words()))
    check('beside another hold the two are two sentences', words(1) === '1 pending control request would not survive a park; 1 crewmate is waiting to retry by itself', String(words(1)))
    const quiescence = new RunnerQuiescence({ refusal: () => words(), flush: async () => {} })
    const refused = await quiescence.request({ subtype: 'quiesce', action: 'prepare', token: 'census-wall-token-0001' })
    check("the runner's fence refuses a park with that sentence", refused.ok === false && refused.reason === '1 crewmate is waiting to retry by itself', JSON.stringify(refused))
    pausedAtAWall('census-wall-2')
    check('two read in the plural', words() === '2 crewmates are waiting to retry by themselves', String(words()))
    utils.cancelAutomaticResume('census-wall-1')
    utils.cancelAutomaticResume('census-wall-2')
    const freed = await new RunnerQuiescence({ refusal: () => words(), flush: async () => {} }).request({ subtype: 'quiesce', action: 'prepare', token: 'census-wall-token-0002' })
    check('once nothing waits the hold is gone and the fence prepares', words() === null && freed.ok === true, JSON.stringify({ words: words(), freed }))
    check('the count is the one the crew keeps of its own armed and starting retries', src('src/daemon/runnerCapabilityCensus.ts').includes('return armedAutomaticResumeCount()'))
  }

  console.log('C5 the runner refuses a park on the census, after its own turn and task checks')
  const runner = src('src/cli/run.ts')
  const at = runner.indexOf('const quiescence = new RunnerQuiescence({')
  const arm = runner.slice(at, runner.indexOf('flush: () => flushSessionStorage()', at))
  check("the quiesce refusal ends on the census (turn, queued prompt, background tasks first; the census closes it)", at > 0 && arm.includes("return 'a turn is running'") && arm.includes("return 'a prompt is queued'") && arm.includes('return capabilityHoldWords(runnerCapabilityHolds(asks))'), arm.slice(0, 400))
  const asks = src('src/cli/headless/runnerAsks.ts')
  check("the runner's ask host counts EVERY pending request on the door (asks and questions alike), not only the parked permission asks", asks.includes('pendingControlRequestCount: () => peer.pendingCount'))
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
