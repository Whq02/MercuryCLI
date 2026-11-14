import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DIST, makeTally } from '../daemon/dupline-world.ts'

const tally = makeTally('prove-run-wake-dispatch-bounds')
const scratch = process.env.MERCURY_CONFIG_DIR
assert(scratch, 'run with a scratch MERCURY_CONFIG_DIR')
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
