#!/usr/bin/env bun
import { mock } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'coordinator-switch-')))
const home = join(scratch, 'home')
const crewDir = join(scratch, 'crew')
const recordsDir = join(scratch, 'daemon')
const draftDir = join(scratch, 'draft')
const project = join(scratch, 'project')
for (const d of [home, crewDir, recordsDir, draftDir, project]) mkdirSync(d, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = home
process.env.MERCURY_CREW_DIR = crewDir
process.env.MERCURY_DAEMON_DIR = recordsDir
for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'NODE_ENV']) delete process.env[key]
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:1'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures += 1
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')
const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

console.log('============================================================')
console.log(' the coordinator switch — off by default, back only through --coordinator-on')
console.log('============================================================')

const { enableConfigs, getGlobalConfig, saveGlobalConfig } = await import('../../src/utils/config.ts')
enableConfigs()

const realModels = await import('../../src/services/concourse/coordinatorModels.ts')
const realValidate = realModels.validateCoordinatorModelChoice
const realCompose = realModels.composeCoordinatorModelRegistry
let modelResolutions = 0
mock.module('../../src/services/concourse/coordinatorModels.ts', () => ({
  ...realModels,
  validateCoordinatorModelChoice: async (id: string | undefined) => {
    modelResolutions += 1
    return realValidate(id)
  },
  composeCoordinatorModelRegistry: async () => {
    modelResolutions += 1
    return realCompose()
  },
}))

const sw = await import('../../src/services/concourse/concourseEnabled.ts')
const kernel = await import('../../src/services/concourse/coordinatorKernel.ts')
const lane = await import('../../src/services/concourse/coordinatorLane.ts')
const models = await import('../../src/services/concourse/coordinatorModels.ts')
const manager = await import('../../src/services/concourse/managerMode.ts')
const compact = await import('../../src/services/concourse/coordinatorCompact.ts')
const conv = await import('../../src/services/concourse/coordinatorConversation.ts')
const receipts = await import('../../src/services/concourse/coordinatorReceipts.ts')
const snapshot = await import('../../src/services/concourse/concourseSnapshot.ts')
const activity = await import('../../src/services/crew/activity.ts')
const { openObligations } = await import('../../src/services/crew/obligations.ts')
const { projectIdentity } = await import('../../src/utils/bootCardFacts.ts')
const report = await import('../../src/utils/healthReport.ts')
const { MERCURY_COORDINATOR_CONTRACT } = await import('../../src/prompt/mercuryContract.ts')

const configPath = join(home, '.mercury.json')
const configBytes = (): string => (existsSync(configPath) ? readFileSync(configPath, 'utf8') : '')
const walk = (dir: string): string[] => {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}
const coordinatorArtefacts = (): string[] =>
  [...walk(home), ...walk(crewDir)].filter(f => /coordinator/i.test(f.slice(scratch.length)) || /concourse-coordinator|Concourse Coordinator/.test(readFileSync(f, 'utf8')))
const feedRows = (): number => activity.activityRows(activity.cachedActivityFeed()).length
const buildSnapshot = (): ReturnType<typeof snapshot.buildConcourseSnapshot> =>
  snapshot.buildConcourseSnapshot({ recordsDir, crewDir, draftDir, nowMs: Date.now(), project: projectIdentity(project) })
const wrapperRow = async (): Promise<string> => {
  const cert = await report.runHealthReport({ depth: 'fast' })
  return String(cert.sections.flatMap(s => s.checks).find(c => c.id === 'wrapper')?.evidence ?? '')
}
const refusedEvent = (id: string) => ({ kind: 'dispatch-refused' as const, clientMessageId: id, reason: 'ceiling', workspaceDir: project, promptPreview: 'p' })
const switchReads = (): boolean | undefined => (typeof sw.coordinatorEnabled === 'function' ? sw.coordinatorEnabled() : undefined)
const storedMode = (): Promise<string | undefined> =>
  typeof kernel.requestedCoordinatorMode === 'function' ? kernel.requestedCoordinatorMode() : Promise.resolve(undefined)

section('§1 a fresh config home: the switch reads off and so does every seam')
{
  check('a fresh home carries no coordinatorEnabled', !configBytes().includes('coordinatorEnabled'))
  check('the switch reads OFF by default', switchReads() === false)
  check("the kernel's stored mode reads 'off' under the switch", (await storedMode()) === 'off')
  const effective = await lane.resolveEffectiveCoordinator()
  check("the lane resolves 'off' (requested and effective) with no model bound", effective.resolution.requested === 'off' && effective.resolution.effective === 'off' && effective.assistModelId === undefined, JSON.stringify(effective))
  const snap = await buildSnapshot()
  check("the snapshot's coordinator.mode reads 'off' with no model label and no fallback reason", snap.coordinator.mode === 'off' && snap.coordinator.assistModelLabel === undefined && snap.coordinator.fallbackReason === undefined, JSON.stringify(snap.coordinator))
  check('the seat denominator counts no coordinator seat', snap.counts.seatsHeld === 0)
  check('booting the concourse resolved NO coordinator model', modelResolutions === 0, String(modelResolutions))
  check('…and wrote no coordinator artefact (no conversation, journal or identity)', coordinatorArtefacts().length === 0, coordinatorArtefacts().join(', '))
}

section('§2 an old stored preference (agent-assisted, a model, an effort) does not turn it on')
{
  saveGlobalConfig(c => ({ ...c, concourseCoordinator: { mode: 'agent-assisted' as const, assistModel: 'claude-sonnet-5', effort: 'high' } }))
  check('the preference is stored as the old version wrote it', getGlobalConfig().concourseCoordinator?.mode === 'agent-assisted' && getGlobalConfig().concourseCoordinator?.assistModel === 'claude-sonnet-5')
  check('the switch still reads OFF (nothing migrates into on)', switchReads() === false)
  check("the stored mode still reads 'off' under the switch", (await storedMode()) === 'off')
  check("the lane still resolves 'off'", (await lane.resolveEffectiveCoordinator()).resolution.effective === 'off')
  check("the snapshot still reads 'off'", (await buildSnapshot()).coordinator.mode === 'off')
  check('still NO coordinator model resolution', modelResolutions === 0, String(modelResolutions))

  activity._resetActivityFeedForTesting()
  lane._resetCoordinatorLaneForTesting()
  const ride = await kernel.runCoordinatorKernel(refusedEvent('sw-off-1'), { crewDir })
  check("a daemon-shaped kernel ride (no mode passed) executes nothing", ride.length === 0, JSON.stringify(ride))
  check('…and raised no obligation', !(await openObligations({ dir: crewDir, scope: 'switchboard' })).some(o => o.ref === 'kernel:capacity:sw-off-1'))
  const turn = await lane.runCoordinatorTurn(refusedEvent('sw-off-2'), { crewDir })
  check("runCoordinatorTurn answers not-assisted ('coordinator off') with no receipts", turn.outcome === 'not-assisted' && turn.receipts.length === 0 && /coordinator off/.test(turn.reason ?? ''), JSON.stringify(turn))
  let modelCalls = 0
  const assisted = await lane.runAssistedTurn(
    { kind: 'operator-message', messageId: 'sw-off-3', text: 'start a session on the repo' },
    { crewDir, callModel: async () => { modelCalls += 1; return { decisions: [] } } },
  )
  check('runAssistedTurn answers not-assisted with the switch line and NO model call', assisted.outcome === 'not-assisted' && modelCalls === 0 && assisted.reason === sw.COORDINATOR_OFF_LINE, JSON.stringify(assisted))
  let accepted = 0
  const door = await lane.runOperatorMessageTurn('start a session on the repo', { crewDir }, { clientMessageId: 'sw-off-4', onAccepted: () => { accepted += 1 } })
  check("the composer door answers self-managed-launch (the board starts the session itself)", 'kind' in door && door.kind === 'self-managed-launch' && door.text === 'start a session on the repo' && accepted === 1, JSON.stringify(door))
  check('…and started no coordinator conversation (not even the off hint)', (await conv.readCoordinatorConversation()).length === 0 && !existsSync(join(home, 'coordinator-conversation.json')))
  const mgr = await manager.resolveManagerModel()
  check('manager mode answers the one plain line', !mgr.ok && mgr.reason === 'coordinator-off' && mgr.line === sw.COORDINATOR_OFF_LINE, JSON.stringify(mgr))
  const folded = await compact.summarizeCoordinatorConversation({ dir: scratch })
  check('a manual compact answers the one plain line and folds nothing', folded.compacted === 0 && folded.refused === sw.COORDINATOR_OFF_LINE, JSON.stringify(folded))
  const before = feedRows()
  const modeSwitch = await models.switchCoordinatorMode('rules-only')
  const modelSwitch = await models.switchCoordinatorAssistModel('claude-opus-5')
  const effortSwitch = await models.switchCoordinatorEffort('low')
  check("the three settings doors refuse typed ('coordinator-off') naming the switch", [modeSwitch, modelSwitch, effortSwitch].every(r => r.outcome === 'refused' && r.reason === 'coordinator-off' && r.detail === sw.COORDINATOR_OFF_LINE), JSON.stringify([modeSwitch, modelSwitch, effortSwitch]))
  check('…leaving the stored preference exactly as it was', getGlobalConfig().concourseCoordinator?.mode === 'agent-assisted' && getGlobalConfig().concourseCoordinator?.assistModel === 'claude-sonnet-5' && getGlobalConfig().concourseCoordinator?.effort === 'high')
  check('…and rowing no receipt on the feed', feedRows() === before && feedRows() === 0, `${before} → ${feedRows()}`)
  check('the one plain line names the switch and the boot it governs', /^coordinator off \(switch\) — `mercury --coordinator-on` turns it on/.test(sw.COORDINATOR_OFF_LINE), sw.COORDINATOR_OFF_LINE)
  check('after every door: still no coordinator model resolution', modelResolutions === 0, String(modelResolutions))
  check('…and still no coordinator artefact in the home or the crew store', coordinatorArtefacts().length === 0, coordinatorArtefacts().join(', '))
  const row = await wrapperRow()
  check("/health's constitution row reads 'coordinator off (switch)' instead of the contract size", row.includes('seat contracts coordinator off (switch)') && !row.includes(`coordinator ${MERCURY_COORDINATOR_CONTRACT.length}`), row)
}

const conversationPath = join(home, 'coordinator-conversation.json')
const journalPath = join(crewDir, 'coordinator-receipt-journal.json')
const artefactsBesideTheFixture = (): string[] => coordinatorArtefacts().filter(f => f !== conversationPath)
const oldPlan = manager.decodeManagerPlan({
  goal: 'ship the widget',
  lanes: [
    { title: 'lane A', scope: 'build the parser', deliverables: 'parser.ts green', territory: 'src/parser/**' },
    { title: 'lane B', scope: 'build the printer', deliverables: 'printer.ts green', territory: 'src/printer/**' },
  ],
  supervision: 'supervising',
  state: 'dispatched',
  laneSessionIds: ['sid-a', null],
  laneWaiting: [1],
  workspaceRoot: project,
})
type RpcOp = { op?: string }
const recorder = (ops: RpcOp[]) => async (req: unknown): Promise<Record<string, unknown>> => {
  const r = req as RpcOp
  ops.push(r)
  if (r.op === 'sessionAdmit') return { ok: true, sessionId: 'sid-b', runnerId: 'r-b' }
  if (r.op === 'sessionDispatch') return { ok: true, state: 'working' }
  return { ok: true, outcome: 'applied' }
}
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 250))

section("§2b an on-disk dispatched plan from 1.0.5 and the board's own gestures: the walkers and the journal stay idle while the switch is off")
{
  check('the fixture decodes as a dispatched, supervising plan with a waiting lane', oldPlan !== null && oldPlan.state === 'dispatched' && oldPlan.supervision === 'supervising' && JSON.stringify(oldPlan.laneWaiting) === '[1]' && oldPlan.workspaceRoot === project, JSON.stringify(oldPlan))
  await conv.appendCoordinatorConversation({ id: 'op:old', role: 'operator', text: 'ship it', ts: 100 })
  await conv.appendCoordinatorConversation({ id: 'plan:old', role: 'coordinator', text: 'the plan', ts: 200, plan: oldPlan } as never)
  const fixtureBytes = readFileSync(conversationPath, 'utf8')
  const stored = (JSON.parse(fixtureBytes) as { entries: Array<{ id: string; plan?: { state?: string; laneWaiting?: number[] } }> }).entries.find(e => e.id === 'plan:old')
  check('the 1.0.5 store is on disk with the dispatched plan', stored?.plan?.state === 'dispatched' && JSON.stringify(stored.plan.laneWaiting) === '[1]', fixtureBytes.slice(0, 200))
  manager._resetManagerSupervisionForTesting()
  const ops: RpcOp[] = []
  const appended = await manager.appendManagerSupervisionRows([{ sessionId: 'sid-a', state: 'completed' }])
  const walked = await manager.startWaitingManagerLane({ live: 0, ceiling: 4 }, { rpc: recorder(ops) })
  check('the supervision walker appends no land row and the waiting-lane walker starts no lane (no RPC)', appended === 0 && walked === null && ops.length === 0, JSON.stringify({ appended, walked, ops }))
  check('…the conversation file is byte-identical', readFileSync(conversationPath, 'utf8') === fixtureBytes)
  check('…and no identity or journal appeared beside the fixture', artefactsBesideTheFixture().length === 0, artefactsBesideTheFixture().join(', '))
  const screen = src('src/components/concourse/ConcourseScreen.tsx')
  check("the screen's manager walker effect asks the switch beside the reduced stage", /useEffect\(\(\) => \{\s*\n\s*if \(reducedStage \|\| !coordinatorOn\) return\s*\n\s*const rows = sessionRows\.map/.test(screen) && screen.includes('reducedStage, coordinatorOn, sessionRows, callbacks]'))
  const managerSrc = src('src/services/concourse/managerMode.ts')
  check('the two manager entry points ask the switch before the store is read or a lane starts', /export async function startWaitingManagerLane[\s\S]{0,400}?coordinatorEnabled\(\)\) return null/.test(managerSrc) && /export async function appendManagerSupervisionRows[\s\S]{0,200}?coordinatorEnabled\(\)\) return 0/.test(managerSrc))
  const feedBefore = feedRows()
  receipts.ingestCoordinatorReceipts([{ verb: 'session.pause', objectRef: 'sid-a', outcome: 'applied', actorAgentId: 'operator' }], { crewDir })
  await settle()
  check("the operator's own board gesture still rows on the in-process feed", feedRows() === feedBefore + 1, `${feedBefore} → ${feedRows()}`)
  check('…but journals nothing on disk while the switch is off', !existsSync(journalPath))
  check('the journal writer asks the switch first', /function journalPayload[\s\S]{0,200}?if \(!coordinatorEnabled\(\)\) return/.test(src('src/services/concourse/coordinatorReceipts.ts')))
}

section('§3 the gate has one owner and the daemon, the hook and the persona ride it')
{
  const enabled = src('src/services/concourse/concourseEnabled.ts')
  check('the switch lives beside the concourse switch, default off, one setter', enabled.includes('getGlobalConfig().coordinatorEnabled === true') && enabled.includes('export function setCoordinatorEnabled(on: boolean)'))
  const kernelSrc = src('src/services/concourse/coordinatorKernel.ts')
  check("the kernel's stored-mode reader asks the switch before the config", /export async function requestedCoordinatorMode[\s\S]*?coordinatorEnabled\(\)\) return 'off'/.test(kernelSrc))
  for (const file of ['src/daemon/concourseDispatch.ts', 'src/daemon/concourseWorkers.ts']) {
    const text = src(file)
    const call = text.slice(text.indexOf('runCoordinatorKernel('), text.indexOf('runCoordinatorKernel(') + 400)
    check(`${file}: the kernel ride passes no mode, so it idles on the switch`, text.includes('runCoordinatorKernel(') && !/mode:/.test(call))
  }
  check('the receipt fold hook asks the switch before subscribing or polling', /useEffect\(\(\) => \{\s*\n\s*if \(!coordinatorEnabled\(\)\) return/.test(src('src/hooks/useCoordinatorReceiptFold.ts')))
  const call = src('src/services/concourse/coordinatorCall.ts')
  check('the coordinator persona is composed only on the coordinator call (behind the lane the switch gates)', call.includes('MERCURY_COORDINATOR_CONTRACT') && !src('src/constants/prompts.ts').includes('MERCURY_COORDINATOR_CONTRACT'))
  const handler = src('src/hooks/toolPermission/handlers/coordinatorHandler.ts')
  check("the permission 'coordinator' handler is the hook runner for every tool ask and reads no switch (the decision: it is not the concourse coordinator)", handler.includes('ctx.runHooks(permissionMode, suggestions, updatedInput)') && !handler.includes('coordinatorEnabled'))
  const schema = src('src/utils/config/schema.ts')
  check('the key is registered in the schema and the key list beside concourseEnabled', schema.includes('coordinatorEnabled?: boolean') && schema.includes("'coordinatorEnabled',"))
  check('…with its boolean shape declared for the field-shape reader', src('src/utils/config/globalConfig.ts').includes("coordinatorEnabled: 'boolean'"))
}

section('§4 --coordinator-on persists the key; the stored preference applies; the services are reachable')
{
  sw.setCoordinatorEnabled(true)
  check('the field is PERSISTED under its registered name', /"coordinatorEnabled"\s*:\s*true/.test(configBytes()), configBytes())
  const child = Bun.spawnSync({
    cmd: [process.execPath, '-e', "const m = await import('./src/services/concourse/concourseEnabled.ts'); const c = await import('./src/utils/config.js'); c.enableConfigs(); console.log(String(m.coordinatorEnabled()))"],
    cwd: ROOT,
    env: { ...process.env, MERCURY_CONFIG_DIR: home },
  })
  check('the ON state survives a fresh process (re-read from disk — the next boot)', child.stdout.toString().trim() === 'true', child.stderr.toString().slice(-200))
  check("the stored mode now reads through ('agent-assisted')", (await storedMode()) === 'agent-assisted')
  const effective = await lane.resolveEffectiveCoordinator()
  check("the lane lifts to 'agent-assisted' and binds the stored model", effective.resolution.effective === 'agent-assisted' && effective.assistModelId === 'claude-sonnet-5', JSON.stringify(effective))
  check('…which is the first coordinator model resolution of this run', modelResolutions > 0, String(modelResolutions))
  const snap = await buildSnapshot()
  check("the snapshot's coordinator.mode reads 'agent-assisted' with the model label", snap.coordinator.mode === 'agent-assisted' && snap.coordinator.assistModelLabel !== undefined, JSON.stringify(snap.coordinator))
  activity._resetActivityFeedForTesting()
  lane._resetCoordinatorLaneForTesting()
  let seenModel = ''
  const assisted = await lane.runAssistedTurn(
    { kind: 'operator-message', messageId: 'sw-on-1', text: 'raise the switch question' },
    { crewDir, callModel: async (_input, modelId) => { seenModel = modelId; return { decisions: [{ verb: 'attention.raise', ref: 'sw:on', sessionId: 's-sw', question: 'on?', owner: 'operator' }] } } },
  )
  check('an assisted turn executes on the stored model', assisted.outcome === 'executed' && seenModel === 'claude-sonnet-5' && assisted.receipts.some(r => r.verb === 'attention.raise' && r.outcome === 'applied'), JSON.stringify(assisted))
  const ride = await kernel.runCoordinatorKernel(refusedEvent('sw-on-2'), { crewDir })
  check('the daemon-shaped kernel ride runs again (R1 raises)', ride.some(r => r.verb === 'attention.raise' && r.outcome === 'applied'), JSON.stringify(ride))
  check('…and its receipts rowed on the feed', feedRows() > 0)
  check('the coordinator artefacts now exist (the probe above was not vacuous)', coordinatorArtefacts().length > 0, coordinatorArtefacts().join(', '))
  const mgr = await manager.resolveManagerModel()
  check('manager mode resolves its model', mgr.ok === true, JSON.stringify(mgr))
  manager._resetManagerSupervisionForTesting()
  const ops: RpcOp[] = []
  const appended = await manager.appendManagerSupervisionRows([{ sessionId: 'sid-a', state: 'completed' }])
  check('the same on-disk plan is supervised again: the land row is appended', appended === 1 && (await conv.readCoordinatorConversation()).some(e => e.id === 'mgr:land:sid-a'), String(appended))
  const walked = await manager.startWaitingManagerLane({ live: 0, ceiling: 4 }, { rpc: recorder(ops) })
  check('…and the waiting lane starts through the RPC', walked === 1 && ops.some(o => o.op === 'sessionAdmit'), JSON.stringify({ walked, ops: ops.map(o => o.op) }))
  receipts.ingestCoordinatorReceipts([{ verb: 'session.resume', objectRef: 'sid-a', outcome: 'applied', actorAgentId: 'operator' }], { crewDir })
  await settle()
  check("the operator's board gesture journals on disk again", existsSync(journalPath) && readFileSync(journalPath, 'utf8').includes('session.resume'))
  const effort = await models.switchCoordinatorEffort('low')
  check('the settings doors apply again', effort.outcome === 'applied' && getGlobalConfig().concourseCoordinator?.effort === 'low', JSON.stringify(effort))
  const row = await wrapperRow()
  check("/health's constitution row names the coordinator contract size again", row.includes(`seat contracts coordinator ${MERCURY_COORDINATOR_CONTRACT.length}`) && !row.includes('off (switch)'), row)
}

section('§4b a home that never stored a mode or a model: --coordinator-on alone yields the assisted coordinator (the box\'s FRC2W-U-30)')
{
  const kept = getGlobalConfig().concourseCoordinator
  saveGlobalConfig(c => ({ ...c, concourseCoordinator: undefined }))
  check('nothing stored under concourseCoordinator', getGlobalConfig().concourseCoordinator === undefined)
  check("the kernel's requested mode reads 'agent-assisted' with the switch on and no stored mode", (await storedMode()) === 'agent-assisted')
  const fresh = await lane.resolveEffectiveCoordinator()
  const registry = await models.composeCoordinatorModelRegistry()
  const expected = (registry.entries.find(entry => entry.availability === 'ready') ?? registry.entries[0])?.modelId
  check("the lane resolves 'agent-assisted' on the registry's first ready model without a stored choice", fresh.resolution.effective === 'agent-assisted' && fresh.assistModelId !== undefined && fresh.assistModelId === expected, JSON.stringify({ fresh, expected }))
  check("the snapshot's coordinator.mode reads 'agent-assisted' — the pane's gate — with a model label", (await buildSnapshot()).coordinator.mode === 'agent-assisted' && (await buildSnapshot()).coordinator.assistModelLabel !== undefined)
  check('the default is never written to the preference file', getGlobalConfig().concourseCoordinator === undefined && !configBytes().includes('assistModel'))
  saveGlobalConfig(c => ({ ...c, concourseCoordinator: kept }))
}

section('§5 --coordinator-off turns it off again; the preference survives for the next --coordinator-on')
{
  sw.setCoordinatorEnabled(false)
  check('the field is persisted false', /"coordinatorEnabled"\s*:\s*false/.test(configBytes()), configBytes())
  check("every seam reads 'off' again", switchReads() === false && (await storedMode()) === 'off' && (await lane.resolveEffectiveCoordinator()).resolution.effective === 'off' && (await buildSnapshot()).coordinator.mode === 'off')
  check('the stored preference is untouched by the switch', getGlobalConfig().concourseCoordinator?.mode === 'agent-assisted' && getGlobalConfig().concourseCoordinator?.assistModel === 'claude-sonnet-5')
  const ride = await kernel.runCoordinatorKernel(refusedEvent('sw-off-5'), { crewDir })
  check('the kernel ride idles again', ride.length === 0)
}

section('§6 the boot grammar: two options in the concourse switch\'s shape, interactive only, last wins')
{
  const main = src('src/main.tsx')
  check('the two options exist with the help voice of the concourse switch', main.includes(".option('--coordinator-on', 'Turn the concourse coordinator on for this and every future boot (persisted; the default is off") && main.includes(".option('--coordinator-off', 'Turn the concourse coordinator off again for this and every future boot (persisted;"))
  check('both are interactive boot options (run and runner refuse them)', /INTERACTIVE_BOOT_OPTIONS: ReadonlySet<string> = new Set\(\[[^\]]*'--coordinator-off', '--coordinator-on'/.test(main))
  check('the boot switch writes through the one door, the later switch winning', main.includes("const lastSwitch = [...process.argv].reverse().find(a => a === '--coordinator-off' || a === '--coordinator-on')") && main.includes("setCoordinatorEnabled(lastSwitch === '--coordinator-on')"))
  check('exactly one CLI writer of the field', (main.match(/setCoordinatorEnabled\(/g) ?? []).length === 1)
  const dist = join(ROOT, 'dist', 'mercury.mjs')
  if (!existsSync(dist)) {
    check('dist/mercury.mjs is built (bun run build.ts first)', false, dist)
  } else {
    type Run = { rc: number; out: string; err: string }
    const runMercury = (args: string[]): Promise<Run> =>
      new Promise(resolve => {
        const child = spawn('node', [dist, ...args], {
          env: { ...process.env, MERCURY_CONFIG_DIR: home, ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key' },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let out = ''
        let err = ''
        child.stdout.on('data', d => (out += String(d)))
        child.stderr.on('data', d => (err += String(d)))
        const k = setTimeout(() => child.kill('SIGKILL'), 60_000)
        child.on('close', rc => { clearTimeout(k); resolve({ rc: rc ?? -1, out, err }) })
      })
    const help = await runMercury(['--help'])
    check('`mercury --help` lists --coordinator-on and --coordinator-off', help.rc === 0 && /--coordinator-on\s/.test(help.out) && /--coordinator-off\s/.test(help.out), help.out.slice(0, 200))
    const runHelp = await runMercury(['run', '--help'])
    check('`mercury run --help` lists neither (an interactive boot\'s switch)', runHelp.rc === 0 && !runHelp.out.includes('--coordinator-on') && !runHelp.out.includes('--coordinator-off'))
    const control = await runMercury(['run', '--frobnicate', 'probe'])
    const refused = await runMercury(['run', '--coordinator-on', 'probe'])
    check('`mercury run --coordinator-on` is the parser\'s unknown option (same answer and exit as --frobnicate)', refused.rc === control.rc && refused.out === '' && refused.err === control.err.replaceAll('--frobnicate', '--coordinator-on'), `rc=${refused.rc} ${JSON.stringify((refused.err + refused.out).slice(0, 160))}`)
    check('…and persisted nothing', /"coordinatorEnabled"\s*:\s*false/.test(configBytes()))
  }
}

section('§7 the screen and the docs say it is off and name the switch')
{
  const settings = src('src/components/Settings/Config.tsx')
  const row = settings.slice(settings.indexOf('const coordinatorOn = '), settings.indexOf("id: 'seats'"))
  check("/config carries a 'Concourse coordinator' row that reads the switch", row.includes("label: 'Concourse coordinator'") && row.includes('config.coordinatorEnabled === true'))
  check('…as an info row naming the switch both ways, never the old toggle', row.includes("kind: 'info'") && row.includes('`mercury --coordinator-on` turns it on') && row.includes('`mercury --coordinator-off` turns it off') && !row.includes('change:') && !row.includes('concourseCoordinator'))
  check('the preflight row prints the same off words instead of the contract size', src('src/utils/healthPreflight.ts').includes("seat contracts coordinator ${coordinatorEnabled() ? MERCURY_COORDINATOR_CONTRACT.length : 'off (switch)'}"))
  const crew = src('docs/CREW.md')
  check('CREW.md says the coordinator is off by default and names the switch', crew.includes('The coordinator is off by default. `mercury --coordinator-on` turns it on') && crew.includes('`--coordinator-off` turns it off again'))
}

section("§8 the mcp-server `--coordinator <session-id>` role addressing is not the concourse coordinator (the decision: unchanged by the switch)")
{
  const { clientReach } = await import('../../src/services/mcp/automationAccess.ts')
  const id = '00000000-0000-4000-8000-000000000001'
  const reach = clientReach({ name: 'c', run: false, send: ['coordinator'] }, { coordinator: id })
  check('with the switch off the role still resolves to the named session (a session id, not the coordinator lane)', switchReads() === false && reach.send[0] === id, JSON.stringify(reach))
  check('its source reads no switch', !src('src/cli/mcpServer.ts').includes('coordinatorEnabled') && !src('src/services/mcp/automationAccess.ts').includes('coordinatorEnabled'))
}

removeScratch(scratch)
console.log('\n' + '═'.repeat(60))
console.log(failures === 0 ? '✅ COORDINATOR-SWITCH GREEN' : `❌ COORDINATOR-SWITCH RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
