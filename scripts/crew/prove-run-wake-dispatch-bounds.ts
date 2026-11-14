import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DIST, makeTally } from '../daemon/dupline-world.ts'
import { findFiles } from './crew-world.ts'

const { Database } = createRequire(import.meta.url)('bun:sqlite')
const tally = makeTally('prove-run-wake-dispatch-bounds')
const scratch = process.env.MERCURY_CONFIG_DIR
assert(scratch, 'run with a scratch MERCURY_CONFIG_DIR')
if (process.env.RUN_WAKE_PROOF_HOME === undefined) {
  const own = mkdtempSync(join(scratch, 'run-wake-home-'))
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, HOME: own, USERPROFILE: own, RUN_WAKE_PROOF_HOME: own } })
  rmSync(own, { recursive: true, force: true })
  process.exit(child.status ?? 1)
}
assert.equal(homedir(), process.env.RUN_WAKE_PROOF_HOME, 'the proof loads the product under its own scratch home')
const root = mkdtempSync(join(scratch, 'run-wake-ends-'))
const source = join(dirname(DIST), '..', 'src')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const boot = await import(join(source, 'bootstrap/state.ts'))
boot.setOriginalCwd(root); boot.setCwdState(root); boot.setProjectRoot(root)
const { enableConfigs } = await import(join(source, 'utils/config/globalConfig.ts'))
enableConfigs()
const { updateSettingsForSource } = await import(join(source, 'utils/settings/settings.ts'))
updateSettingsForSource('userSettings', { swarm: { enabled: true } })
const seam = await import(join(source, 'services/crewBoard/seam.ts'))
const { flushSessionStorage } = await import(join(source, 'utils/sessionStorage/writer.ts'))
const { runSwarmCommand } = await import(join(source, 'commands/swarm/swarm.ts'))
assert(runSwarmCommand('on').startsWith('Swarm on'))
await seam.latchSwarmAgent('poster', 'Poster')
const store = () => seam.swarmStore()!
const tasks: Record<string, { type: string; id: string; agentId: string; status: string }> = {}
let contextReads = 0
const context = { getAppState: () => { contextReads++; return { tasks } }, options: {}, abortController: new AbortController() }
const turn = async (): Promise<void> => { await flushSessionStorage(); for (let n = 0; n < 6; n++) await new Promise<void>(resolve => setImmediate(resolve)) }
let serial = 0
async function park(id: string, status = 'completed'): Promise<void> {
  await seam.latchSwarmAgent(id, id)
  tasks[id] = { type: 'local_agent', id, agentId: id, status }
  const waited = store().post(seam.swarmPrincipal(id)!, { clientOpId: `wait-${id}`, kind: 'ask', text: `@main wake me when seat poster posts` })
  assert(waited.ok, JSON.stringify(waited))
  seam.settleSwarmAgent(id)
  seam.mirrorSwarmNotice(id, `completed ${id}`, `${id} completed`, 'completed')
}
const trigger = (): void => { assert(store().post(seam.swarmPrincipal('poster')!, { clientOpId: `trigger-${++serial}`, kind: 'result', text: `TRIGGER-${serial}` }).ok) }
type Resume = (args: { agentId: string; onAdmitted?: () => void }) => Promise<unknown>
const admit: Resume = async args => { args.onAdmitted?.() }

try {
  tally.section('a run that is ending starts no further seat')
  {
    let alive = true
    const started: string[] = []
    const watcher = seam.watchSwarmResumes(() => context, async () => ({ behavior: 'allow', updatedInput: {} }), () => alive, (async args => { started.push(args.agentId); alive = false; args.onAdmitted?.() }) as Resume)
    await park('first'); await park('second')
    await turn()
    trigger()
    await turn()
    tally.check('two parked seats had a wake each and the first was resumed', started.length >= 1, JSON.stringify(started))
    tally.check('the seat whose turn came after the run began to end is not started', started.length === 1, JSON.stringify(started))
    tally.check('its wake stays pending for the session that resumes this one', store().pendingWakes().length === 1 && !watcher.hasPending(), JSON.stringify(store().pendingWakes()))
    watcher.stop()
    alive = true
    const rest = seam.watchSwarmResumes(() => context, async () => ({ behavior: 'allow', updatedInput: {} }), () => true, admit)
    await turn()
    tally.check('a live dispatcher takes the wake that was left', store().pendingWakes().length === 0)
    rest.stop()
  }

  tally.section('a wake that waits on a running seat is asked about without a dispatch pass')
  {
    const started: string[] = []
    const watcher = seam.watchSwarmResumes(() => context, async () => ({ behavior: 'allow', updatedInput: {} }), () => true, (async args => { started.push(args.agentId); args.onAdmitted?.() }) as Resume)
    await park('busy', 'running')
    await turn()
    trigger()
    await turn()
    const before = contextReads
    let answers = 0
    for (let n = 0; n < 50; n++) { if (watcher.hasPending()) answers++; await turn() }
    tally.check('fifty questions while the seat runs read the tasks fifty times and start nothing', contextReads - before === 50 && answers === 0 && started.length === 0 && store().pendingWakes().length === 1, `reads=${contextReads - before} answers=${answers}`)
    tasks.busy!.status = 'completed'
    const live = watcher.hasPending()
    await turn()
    tally.check('once the seat has ended one question resumes it and the next reads nothing pending', live && started.length === 1 && !watcher.hasPending(), JSON.stringify(started))
    watcher.stop()
  }

  tally.section('a wake the dispatcher cannot claim stops being counted')
  {
    const started: string[] = []
    const watcher = seam.watchSwarmResumes(() => context, async () => ({ behavior: 'allow', updatedInput: {} }), () => true, (async args => { started.push(args.agentId); args.onAdmitted?.() }) as Resume)
    await park('orphan', 'running')
    await turn()
    trigger()
    await turn()
    const db = new Database(findFiles(scratch, 'board.sqlite')[0]!)
    const mine = (db.query("SELECT execution FROM members WHERE agent = 'main'").get() as { execution: string }).execution
    db.query("UPDATE members SET execution = 'another-runner' WHERE agent = 'main'").run()
    tasks.orphan!.status = 'completed'
    const answers: boolean[] = []
    for (let n = 0; n < 8; n++) { answers.push(watcher.hasPending()); await turn() }
    tally.check('the wake is tried when its seat ends', answers[0] === true, JSON.stringify(answers))
    tally.check('a dispatch that failed does not keep the run alive', answers.slice(2).every(answer => !answer) && started.length === 0, JSON.stringify(answers))
    db.query("UPDATE members SET execution = ? WHERE agent = 'main'").run(mine)
    db.close()
    trigger()
    await turn()
    tally.check('the next board event tries again and the wake is delivered', started.length === 1 && store().pendingWakes().length === 0, JSON.stringify(started))
    watcher.stop()
  }

  tally.section('the seats a run still waits on are counted once each')
  {
    let enter!: () => void, release!: () => void, first = ''
    const entered = new Promise<void>(resolve => { enter = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const watcher = seam.watchSwarmResumes(() => context, async () => ({ behavior: 'allow', updatedInput: {} }), () => true, (async args => { first ||= args.agentId; enter(); await gate; tasks[args.agentId]!.status = 'running'; args.onAdmitted?.() }) as Resume)
    const count = (): number => (watcher as { waitingSeats?: () => number }).waitingSeats?.() ?? -1
    await park('counted', 'running'); await park('beside', 'running')
    await turn()
    trigger()
    await turn()
    tally.check('a wake on a seat that still runs is no seat waited on', count() === 0 && store().pendingWakes().length === 2, `count=${count()}`)
    tasks.counted!.status = 'completed'; tasks.beside!.status = 'completed'
    tally.check('two seats that have ended with a wake each count two', count() === 2, `count=${count()}`)
    watcher.check()
    await entered
    tally.check('a seat in admission is counted though its wake has left the pending list', store().pendingWakes().length === 1 && count() === 2, `count=${count()}`)
    tasks[first]!.status = 'running'
    tally.check('once its task runs it is no longer counted as a seat waited on', count() === 1, `count=${count()}`)
    release()
    await turn()
    tally.check('with both admitted no seat is waited on', count() === 0 && store().pendingWakes().length === 0 && !watcher.hasPending(), `count=${count()}`)
    watcher.stop()
  }

  tally.section('a wake that waits behind a pause or a stopped seat keeps no run alive')
  {
    const { operatorPauseGate } = await import(join(source, 'run-core/pauseGate.ts'))
    const started: string[] = []
    const watcher = seam.watchSwarmResumes(() => context, async () => ({ behavior: 'allow', updatedInput: {} }), () => true, (async args => { started.push(args.agentId); args.onAdmitted?.() }) as Resume)
    await park('paused'); await park('stopped', 'killed')
    await turn()
    operatorPauseGate.pause()
    trigger()
    await turn()
    tally.check('while the operator pause holds no seat is started and no wake is counted', started.length === 0 && store().pendingWakes().length === 2 && !watcher.hasPending(), JSON.stringify(started))
    operatorPauseGate.resume()
    await turn()
    tally.check('lifting the pause resumes the seat that had ended, and the stopped seat is left to the lead', started.length === 1 && started[0] === 'paused' && store().pendingWakes().length === 1 && !watcher.hasPending(), JSON.stringify(started))
    tasks.stopped!.status = 'completed'
    const live = watcher.hasPending()
    await turn()
    tally.check('a seat that is no longer stopped is counted once and resumed', live && started.length === 2 && !watcher.hasPending(), JSON.stringify(started))
    watcher.stop()
  }

  tally.section('the swarm switched off between two wakes starts no further seat')
  {
    const started: string[] = []
    const watcher = seam.watchSwarmResumes(() => context, async () => ({ behavior: 'allow', updatedInput: {} }), () => true, (async args => { started.push(args.agentId); runSwarmCommand('off'); args.onAdmitted?.() }) as Resume)
    await park('third'); await park('fourth')
    await turn()
    trigger()
    await turn()
    tally.check('the seat after the switch is not started and no longer keeps the run alive', started.length === 1 && !watcher.hasPending(), JSON.stringify(started))
    runSwarmCommand('on')
    await turn()
    tally.check('switching the swarm on again delivers the wake that waited', started.length === 2 && store().pendingWakes().length === 0, JSON.stringify(started))
    watcher.stop()
  }
} finally {
  runSwarmCommand('off')
  rmSync(root, { recursive: true, force: true })
}
tally.finish()
