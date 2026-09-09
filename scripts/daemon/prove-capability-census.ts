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

  console.log('C5 the runner refuses a park on the census, after its own turn and task checks')
  const runner = src('src/cli/print.ts')
  const at = runner.indexOf('const quiescence = new RunnerQuiescence({')
  const arm = runner.slice(at, runner.indexOf('flush: () => flushSessionStorage()', at))
  check("the quiesce refusal ends on the census (turn, queued prompt, background tasks first; the census closes it)", at > 0 && arm.includes("return 'a turn is running'") && arm.includes("return 'a prompt is queued'") && arm.includes('return capabilityHoldWords(runnerCapabilityHolds(io))'), arm.slice(0, 400))
  const io = src('src/cli/structuredIO.ts')
  check('the structured io counts EVERY pending control request (asks, hooks, elicitations), not only permission asks', io.includes('pendingControlRequestCount(): number {\n    return this.#pending.size'))
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
