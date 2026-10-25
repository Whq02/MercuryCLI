import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { mock } from 'bun:test'
import { SCRATCH_ROOT, makeTally, sleep } from './dupline-world.ts'
import type { RunnerChildSpec } from '../../src/daemon/headlessRun.ts'

const tally = makeTally('prove-degraded-clears-with-its-seat')
const scratch = mkdtempSync(join(SCRATCH_ROOT, 'degraded-clears-'))
const home = join(scratch, 'home')
const daemonHome = join(home, 'daemon')
mkdirSync(daemonHome, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonHome
process.env.MERCURY_CREDENTIAL_STORE = 'file'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — prove-degraded-clears-with-its-seat exceeded 60s')
  process.exit(1)
}, 60_000)
watchdog.unref?.()

const realConsoleError = console.error
console.error = (() => {}) as typeof console.error

type FakeChild = EventEmitter & { pid: number; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => boolean }
const fakes: FakeChild[] = []
const realChildren = await import('../../src/daemon/headlessRun.ts')
mock.module('../../src/daemon/headlessRun.ts', () => ({
  ...realChildren,
  spawnRunnerChild: () => {
    const fake = fakes.shift()
    if (fake === undefined) throw new Error('no fake child is armed for this spawn')
    return { child: fake, argv: [], env: {} }
  },
}))
const { TaskRoster } = await import('../../src/daemon/roster.ts')
const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 3 } }))

const degradedReasons: string[] = []
const roster = new TaskRoster({ dir: scratch, breaker: {} as never, maxInflight: 3, onDegraded: reason => degradedReasons.push(reason) })
const specOf = (short: string): RunnerChildSpec => ({
  cwd: scratch,
  model: 'fixture-model',
  effort: 'high',
  appendSystemPrompt: '',
  role: 'MERCURY_CONCOURSE_WORKER',
  agentName: short,
  agentId: `${short}-agent`,
})

function fakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), {
    pid: 2_147_483_001 + fakes.length,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  })
}

function crash(child: FakeChild): void {
  child.emit('exit', 1, null)
  child.emit('close', 1, null)
}

async function degrade(short: string): Promise<void> {
  const first = fakeChild()
  fakes.push(first)
  const registered = roster.registerLongLived(short, specOf(short), { maxRespawns: 1, backoffBaseMs: 1, backoffCapMs: 1, healthyResetMs: 60_000 })
  tally.check(`${short} registers`, registered.ok, JSON.stringify(registered))
  await sleep(20)
  const second = fakeChild()
  fakes.push(second)
  crash(first)
  await sleep(60)
  crash(second)
  await sleep(60)
}

const state = (): { degraded: boolean; reason: string } => roster.getRespawnState()

console.log('============================================================')
console.log(' the daemon degraded mark belongs to the seat that earned it')
console.log(' red on the base: §2 and §3 (the mark outlived the seat: a closed chat left the daemon ▲ DEGRADED until a restart)')
console.log('============================================================')

tally.section('§1 a seat that spends its respawn budget degrades the daemon, loudly, naming the seat')
{
  await degrade('concourse-w9101')
  tally.check('the daemon reads degraded', state().degraded, JSON.stringify(state()))
  tally.check('the reason names the seat and the budget', state().reason === 'concourse-w9101: long-lived worker exceeded 1 respawns', state().reason)
  tally.check('onDegraded fired once with the same words', degradedReasons.length === 1 && degradedReasons[0] === state().reason, JSON.stringify(degradedReasons))
}

tally.section("§2 the operator ends that seat (the chat closes): the mark goes with it")
{
  const killed = roster.kill('concourse-w9101')
  tally.check('kill on the settled seat reaps it', killed)
  tally.check('the daemon no longer reads degraded', !state().degraded, JSON.stringify(state()))
  tally.check('the reason is empty', state().reason === '', state().reason)
}

tally.section('§3 the same seat registers afresh after degrading: the mark clears at the new registration')
{
  await degrade('concourse-w9102')
  tally.check('degraded again, for the second seat', state().degraded && state().reason.startsWith('concourse-w9102: '), state().reason)
  const fresh = fakeChild()
  fakes.push(fresh)
  const again = roster.registerLongLived('concourse-w9102', specOf('concourse-w9102'))
  tally.check('the fresh registration is accepted (the degraded handle had settled)', again.ok, JSON.stringify(again))
  tally.check('the daemon reads healthy again', !state().degraded, JSON.stringify(state()))
  roster.kill('concourse-w9102')
}

tally.section("§4 two degraded seats: ending one keeps the other's mark, with its own words")
{
  await degrade('concourse-w9103')
  await degrade('concourse-w9104')
  tally.check('both seats are named', state().reason === 'concourse-w9103: long-lived worker exceeded 1 respawns; concourse-w9104: long-lived worker exceeded 1 respawns', state().reason)
  roster.kill('concourse-w9103')
  tally.check('the remaining seat keeps the daemon degraded', state().degraded && state().reason === 'concourse-w9104: long-lived worker exceeded 1 respawns', state().reason)
  roster.kill('concourse-w9104')
  tally.check('ending the last one clears it', !state().degraded, JSON.stringify(state()))
}

tally.section('§5 a seat the roster never knew leaves the mark alone')
{
  await degrade('concourse-w9105')
  tally.check('kill of an unknown seat answers false and changes nothing', roster.kill('concourse-w9999') === false && state().degraded, JSON.stringify(state()))
  roster.kill('concourse-w9105')
}

console.error = realConsoleError
try {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 })
} catch {
  console.log(`  scratch kept: ${scratch}`)
}
tally.finish()
