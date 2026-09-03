#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-spawn-switch.ts — THE TWO SPAWN SWITCHES of a
//  session: sub-agents and workflows, on or off, per session
//  (services/switchboard/spawnSwitches.ts — the boot menu's Agents rows at
//  birth, the in-session toggle at the next turn boundary).
//
//    §1  the rows: the two Agents rows are live-class toggles over
//        registered default-on flags; a saved choice persists through the
//        boot-env road and reads back attributed (boot menu · environment ·
//        default); the snapshot carries the class; the explicit apply
//        answers no-change / queued / refused by class.
//    §2  the valve and the latch: the launch-authority valve refuses with
//        the ONE receipt while a switch is off; the process latches its
//        birth value (sticky) and moves only on the in-session toggle.
//    §3  the roster: born with sub-agents off ⇒ no Agent tool (nor the
//        fleet tools); workflows off ⇒ no Workflow tool; both on ⇒ today.
//    §4  the spawn roads answer the receipt: the Agent tool's call, the
//        Workflow tool's validate; the skill fork, the workflow's agent
//        hooks, the fleet tools, the Crew view and the boot menu ride the
//        valve (source pins); the concourse coordinator and the daemon's
//        crew seats never read the switch.
//    §5  the record's view: the admission snapshot's rows and the
//        in-session toggle, through the one owner.
//    §6  the seat verb: idle applies (record + forward + facts), busy
//        parks and the idle edge drains, the respawn re-forwards, the same
//        state no-ops, an unknown session refuses.
//    §7  the preserved-thinking seam: a roster-transition row is a lawful
//        prefix change; the notice names the toggle, never a client-side
//        edit or a Mercury defect; the doctor ledger's wording.
//    §8  the wire (dist): a process born with both switches off carries
//        neither tool; the in-session toggle removes the Agent tool from
//        the NEXT request while the messages prefix stays byte-identical,
//        and a scripted drop paints the toggle receipt.
//    §9  the doctor (dist): the row names both switches with their source.
//    §10 the commands: /subagents (screen seat, crew domain, README roster),
//        /workflows on|off, the argument grammar, the no-chat sentence.
//
//  Requires the prebuilt dist for §8–§9. Run:
//    ~/.bun/bin/bun run scripts/switchboard/prove-spawn-switch.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover', PACKAGE_URL: 'https://github.com/example/mercury' }

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)
process.env.NODE_ENV = 'test'
const HOME = mkdtempSync(join(tmpdir(), 'spawn-switch-home-'))
process.env.MERCURY_CONFIG_DIR = join(HOME, 'config')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
for (const k of ['MERCURY_HOME', 'MERCURY_ENTER_MENU', 'MERCURY_BOOT_ENV_APPLIED', 'MERCURY_SESSION_SUBAGENTS', 'MERCURY_SESSION_WORKFLOWS', 'MERCURY_CONCOURSE_WORKER', 'MERCURY_WORKFLOWS', 'ANTHROPIC_BASE_URL', 'MERCURY_THINKING_BINDING']) delete process.env[k]
process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-not-a-real-key'

const DIST = join(ROOT, 'dist', 'mercury.mjs')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)
const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — spawn-switch proofs exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

const menu = await import('../../src/substrate/startupMenu.ts')
const { getFlagSpec } = await import('../../src/substrate/flagRegistry.ts')
const sw = await import('../../src/services/switchboard/spawnSwitches.ts')
const { evaluateLaunchAuthority } = await import('../../src/services/switchboard/launchAuthority.ts')

const SUB = 'MERCURY_SESSION_SUBAGENTS'
const WF = 'MERCURY_SESSION_WORKFLOWS'
const OFF_SUB = "sub-agents are off for this session — /subagents on, or the boot menu's Agents section"
const OFF_WF = "workflows are off for this session — /workflows on, or the boot menu's Agents section"

// ============================================================================
section('§1 the rows — live-class toggles over registered flags, through the boot-env road')
// ============================================================================
{
  const rows = menu.STARTUP_MENU.filter(r => r.group === 'agents')
  check('the Agents section holds exactly the two rows, sub-agents then workflows', rows.length === 2 && rows[0]?.env === SUB && rows[1]?.env === WF, rows.map(r => r.env).join(','))
  check('both rows read "Sub-agents" and "Workflows"', rows[0]?.label === 'Sub-agents' && rows[1]?.label === 'Workflows')
  check("both are toggles whose one choice is '0' (off) with the default on", rows.every(r => r.kind === 'toggle' && r.options.length === 1 && r.options[0] === '0' && r.defaultLabel === 'on'))
  check('both are the live class', rows.every(r => r.applicationClass === 'live'))
  check('every other row keeps the new-session class (absent = new-session)', menu.STARTUP_MENU.filter(r => r.group !== 'agents').every(r => r.applicationClass === undefined || r.applicationClass === 'new-session'))
  check('the choices paint default (on) first, then off', rows.every(r => menu.menuRowChoices(r).map(c => c.label).join('|') === 'default (on)|off'))
  for (const env of [SUB, WF]) {
    const spec = getFlagSpec(env)
    check(`${env} is registered default-on · behavioral · evidenced by this prover · consumed by the owner`, spec?.kind === 'default-on' && spec.tier === 'behavioral' && spec.evidence === 'scripts/switchboard/prove-spawn-switch.ts' && spec.consumer === 'src/services/switchboard/spawnSwitches.ts', j(spec))
  }
  check('the owner maps each row to its switch and back', sw.SPAWN_SWITCH_ENV.subagents === SUB && sw.SPAWN_SWITCH_ENV.workflows === WF && sw.spawnSwitchKindOfEnv(SUB) === 'subagents' && sw.spawnSwitchKindOfEnv(WF) === 'workflows' && sw.spawnSwitchKindOfEnv('MERCURY_THEMIS') === null)
  check('the splash carries both rows baked (the menu asset never trails the registry)', src('assets/splash/splash-core.mjs').includes(`"env":"${SUB}"`) && src('assets/splash/splash-core.mjs').includes(`"env":"${WF}"`))

  // The boot-env road: a saved off persists, applies on a clean env, and
  // reads back as the boot menu's — never a real pin.
  const path = join(HOME, 'boot-env.json')
  const saved = menu.saveBootDefaultsProfile({ [SUB]: '0' }, path)
  check('the sub-agents row saves through the profile writer', saved.ok === true, j(saved))
  const env: NodeJS.ProcessEnv = {}
  const applied = menu.applyBootMenuEnv(path, env)
  check('the applier lands the row on a clean env', applied !== null && applied.applied.some(a => a.env === SUB && a.value === '0') && applied.refused.length === 0, j(applied))
  check('born with sub-agents off, attributed to the boot menu', j(sw.bornSpawnSwitch('subagents', env)) === j({ on: false, source: 'boot-menu' }), j(sw.bornSpawnSwitch('subagents', env)))
  check('workflows born on by default', j(sw.bornSpawnSwitch('workflows', env)) === j({ on: true, source: 'default' }))
  const pinned: NodeJS.ProcessEnv = { [WF]: '0' }
  check('a value the real environment holds is the environment\'s pin', j(sw.bornSpawnSwitch('workflows', pinned)) === j({ on: false, source: 'env' }))
  check("any value but '0' is on", sw.spawnSwitchOnFromValue('1') && sw.spawnSwitchOnFromValue(null) && sw.spawnSwitchOnFromValue(undefined) && !sw.spawnSwitchOnFromValue('0'))

  // The snapshot carries the class and the value.
  const snap = menu.resolveEffectiveSettingsSnapshot({ sessionId: 'snap', path, env })
  const subRow = snap.rows.find(r => r.env === SUB)
  check("the admission snapshot's sub-agents row: value '0', source profile, class live", subRow?.value === '0' && subRow.source === 'profile' && subRow.applicationClass === 'live', j(subRow))
  check('a new-session row keeps its class in the snapshot', snap.rows.some(r => r.env === 'MERCURY_THEMIS' && r.applicationClass === 'new-session'))
  const record = { settingsSnapshot: snap }
  check("the record's view reads the snapshot row: off, boot menu", j(sw.spawnSwitchOfRecord(record, 'subagents')) === j({ on: false, source: 'boot-menu' }))

  // The explicit apply: the profile moves on (cleared) — the live row
  // answers 'queued' naming the switch; the same row at its live value is
  // no-change; a new-session row still refuses with its class; a real
  // env pin refuses on the law.
  menu.saveBootDefaultsProfile({ MERCURY_MNEME: '1' }, path)
  const profile = menu.readBootDefaultsProfile(path)
  const receipts = menu.evaluateExplicitApply(snap, profile)
  const subReceipt = receipts.find(r => r.env === SUB)
  check("the live row's changed target answers 'queued' and names the session's own switch", subReceipt?.outcome === 'queued' && subReceipt.target === null && subReceipt.reason.includes('application class: live') && subReceipt.reason.includes('next turn boundary'), j(subReceipt))
  const mneme = receipts.find(r => r.env === 'MERCURY_MNEME')
  check("a changed new-session row still refuses with its class named", mneme?.outcome === 'refused' && mneme.reason.includes('application class: new-session'), j(mneme))
  const liveReceipts = menu.evaluateExplicitApply(snap, profile, { [SUB]: null })
  check('the live value decides no-change (an in-session toggle moved the switch on already)', liveReceipts.find(r => r.env === SUB)?.outcome === 'no-change', j(liveReceipts.find(r => r.env === SUB)))
  const pinnedSnap = menu.resolveEffectiveSettingsSnapshot({ sessionId: 'pinned', path, env: pinned })
  const wfReceipt = menu.evaluateExplicitApply(pinnedSnap, profile).find(r => r.env === WF)
  check('an env-pinned live row refuses on the explicit-env-wins law', wfReceipt?.outcome === 'refused' && wfReceipt.reason.includes('pinned by the real environment'), j(wfReceipt))
}

// ============================================================================
section('§2 the valve and the latch — one receipt while off; born once, sticky, moved by the toggle')
// ============================================================================
{
  const off = evaluateLaunchAuthority('subagents', { spawnSwitch: { on: false, source: 'boot-menu' } })
  check('sub-agents off ⇒ the valve refuses with the ONE receipt', !off.allowed && off.reason === OFF_SUB && off.cause === 'session-switch', j(off))
  const offWf = evaluateLaunchAuthority('workflows', { spawnSwitch: { on: false, source: 'in-session' } })
  check('workflows off ⇒ the same shape, the workflows receipt', !offWf.allowed && offWf.reason === OFF_WF && offWf.cause === 'session-switch', j(offWf))
  check('the receipt owner spells both', sw.spawnSwitchOffReceipt('subagents') === OFF_SUB && sw.spawnSwitchOffReceipt('workflows') === OFF_WF)
  const on = evaluateLaunchAuthority('subagents', { spawnSwitch: { on: true, source: 'default' } })
  check("on ⇒ today's answer for an interactive process", on.allowed === true && on.posture === 'attached-or-plain')
  const offBackground = evaluateLaunchAuthority('subagents', { spawnSwitch: { on: false, source: 'boot-menu' }, roleEnvOn: true, sessionId: 'nobody', dir: mkdtempSync(join(tmpdir(), 'spawn-switch-rec-')) })
  check('the switch is read BEFORE the seat posture (a backgrounded runner with the switch off hears the switch)', !offBackground.allowed && offBackground.cause === 'session-switch')
  const background = evaluateLaunchAuthority('subagents', { spawnSwitch: { on: true, source: 'default' }, roleEnvOn: true, sessionId: 'nobody', dir: mkdtempSync(join(tmpdir(), 'spawn-switch-rec-')) })
  check("with the switch on, the background law answers as today (cause 'backgrounded')", !background.allowed && background.cause === 'backgrounded' && background.reason.includes('this session is backgrounded'))

  // The process latch.
  sw._resetSpawnSwitchesForTesting()
  process.env[SUB] = '0'
  check('a real env off is latched at first read as the environment\'s', j(sw.spawnSwitch('subagents')) === j({ on: false, source: 'env' }))
  delete process.env[SUB]
  check('sticky: the latch survives the env moving under it', sw.spawnSwitch('subagents').on === false)
  check('the unprobed valve reads the latch', evaluateLaunchAuthority('subagents').allowed === false)
  const moved = sw.setSpawnSwitch('subagents', true)
  check('the in-session toggle moves the switch and says so', moved.changed === true && j(moved.state) === j({ on: true, source: 'in-session' }))
  check('the same toggle again changes nothing', sw.setSpawnSwitch('subagents', true).changed === false)
  check('the facts carry both switches', j(sw.spawnSwitchFacts()) === j({ subagents: { on: true, source: 'in-session' }, workflows: { on: true, source: 'default' } }))
  // Born through the applier onto process.env: attributed to the boot menu.
  sw._resetSpawnSwitchesForTesting()
  const path = join(HOME, 'boot-env-latch.json')
  menu.saveBootDefaultsProfile({ [WF]: '0' }, path)
  menu.applyBootMenuEnv(path, process.env)
  check("born through the applier: workflows off, the boot menu's", j(sw.spawnSwitch('workflows')) === j({ on: false, source: 'boot-menu' }))
  for (const k of [SUB, WF, 'MERCURY_BOOT_ENV_APPLIED']) delete process.env[k]
  sw._resetSpawnSwitchesForTesting()
}

// ============================================================================
section('§3 the roster — the switches decide which tools the model sees')
// ============================================================================
const { getTools } = await import('../../src/tools.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { AgentTool } = await import('../../src/tools/AgentTool/AgentTool.tsx')
const { WorkflowTool } = await import('../../src/tools/WorkflowTool/WorkflowTool.tsx')
const { LaunchFleetTool } = await import('../../src/tools/LaunchFleetTool/LaunchFleetTool.ts')
const { TeamCreateTool } = await import('../../src/tools/TeamCreateTool/TeamCreateTool.ts')
const rosterNames = (): string[] => getTools({ ...getEmptyToolPermissionContext(), mode: 'default' } as never).map(t => t.name)
{
  sw._resetSpawnSwitchesForTesting()
  const today = rosterNames()
  check("both on (the default) ⇒ the Agent tool and the Workflow tool are in the roster — today's behaviour", today.includes(AgentTool.name) && today.includes(WorkflowTool.name), today.join(','))
  sw.setSpawnSwitch('subagents', false)
  const noAgents = rosterNames()
  check('sub-agents off ⇒ the Agent tool is absent', !noAgents.includes(AgentTool.name), noAgents.join(','))
  check('…the fleet tools are absent too', !noAgents.includes(LaunchFleetTool.name) && !noAgents.includes(TeamCreateTool.name) && LaunchFleetTool.isEnabled() === false && TeamCreateTool.isEnabled() === false)
  check('…the Workflow tool stays (its own switch is on)', noAgents.includes(WorkflowTool.name))
  check('…nothing else moved', j(today.filter(n => n !== AgentTool.name && n !== LaunchFleetTool.name && n !== TeamCreateTool.name)) === j(noAgents))
  sw.setSpawnSwitch('subagents', true)
  sw.setSpawnSwitch('workflows', false)
  const noWorkflows = rosterNames()
  check('workflows off ⇒ the Workflow tool is absent and the Agent tool stays', !noWorkflows.includes(WorkflowTool.name) && noWorkflows.includes(AgentTool.name), noWorkflows.join(','))
  sw.setSpawnSwitch('workflows', true)
  check('both back on ⇒ the roster is today\'s again', j(rosterNames()) === j(today))
}

// ============================================================================
section('§4 the spawn roads — every road answers the receipt, and nothing outside a session reads the switch')
// ============================================================================
{
  sw.setSpawnSwitch('subagents', false)
  let agentError = ''
  try {
    await AgentTool.call({ prompt: 'delegate', description: 'a task' } as never, { options: {} } as never, (async () => ({ behavior: 'allow' })) as never, {} as never)
  } catch (e) {
    agentError = e instanceof Error ? e.message : String(e)
  }
  check("the Agent tool's call answers the receipt (a stale roster's call never spawns)", agentError === OFF_SUB, agentError)
  sw.setSpawnSwitch('subagents', true)
  sw.setSpawnSwitch('workflows', false)
  const validate = (WorkflowTool as unknown as { validateInput?: (input: unknown, ctx: unknown) => Promise<{ result: boolean; message?: string; errorCode?: number }> }).validateInput
  if (typeof validate === 'function') {
    const verdict = await validate.call(WorkflowTool, { name: 'probe', script: 'export default async () => {}' }, { abortController: new AbortController() })
    check("the Workflow tool's validate answers the receipt (error code 7, the launch-authority class)", verdict.result === false && verdict.message === OFF_WF && verdict.errorCode === 7, j(verdict))
  } else {
    check('the Workflow tool exposes validateInput', false)
  }
  sw.setSpawnSwitch('workflows', true)
  sw._resetSpawnSwitchesForTesting()

  // Source pins: the roads ride the ONE valve; the valve reads the ONE owner.
  const valve = src('src/services/switchboard/launchAuthority.ts')
  check('the valve reads the switch owner first (before the role env)', valve.indexOf('spawnSwitch(kind)') !== -1 && valve.indexOf('spawnSwitch(kind)') < valve.indexOf("flagEnv('MERCURY_CONCOURSE_WORKER')") && valve.includes("cause: 'session-switch'"))
  const agentTool = src('src/tools/AgentTool/AgentTool.tsx')
  check('the Agent tool asks the valve at isEnabled and at call time', agentTool.includes("return evaluateLaunchAuthority('subagents').allowed") && agentTool.includes("const authority = evaluateLaunchAuthority('subagents')"))
  const workflowTool = src('src/tools/WorkflowTool/WorkflowTool.tsx')
  check('the Workflow tool asks the valve at isEnabled and at validate', workflowTool.includes("evaluateLaunchAuthority('workflows').allowed") && workflowTool.includes("const launchAuthority = evaluateLaunchAuthority('workflows')"))
  const skill = src('src/tools/SkillTool/SkillTool.ts')
  const forkAt = skill.indexOf("if (command.context === 'fork')")
  check('the skill fork asks the valve before runAgent', forkAt !== -1 && skill.indexOf("evaluateLaunchAuthority('subagents')", forkAt) !== -1 && skill.indexOf("evaluateLaunchAuthority('subagents')", forkAt) < skill.indexOf('runAgent({', forkAt))
  const hooks = src('src/tools/WorkflowTool/agentHooks.ts')
  const adapterAt = hooks.indexOf('async function* adapterSpawnStream(')
  check("the workflow's agent hooks ask the valve before runAgent", adapterAt !== -1 && hooks.indexOf("evaluateLaunchAuthority('subagents')", adapterAt) !== -1 && hooks.indexOf("evaluateLaunchAuthority('subagents')", adapterAt) < hooks.indexOf('runAgent({', adapterAt))
  check('the fleet tools ask the valve at isEnabled', src('src/tools/LaunchFleetTool/LaunchFleetTool.ts').includes("evaluateLaunchAuthority('subagents').allowed") && src('src/tools/TeamCreateTool/TeamCreateTool.ts').includes("evaluateLaunchAuthority('subagents').allowed"))
  const crew = src('src/components/mercury-ui/screens/CrewView.tsx')
  check("the Crew view's spawn key reads the focused session's switch and answers the receipt", crew.includes("getFocusedSessionConnector().spawnSwitches().subagents.on") && crew.includes("spawnSwitchOffReceipt('subagents')") && crew.includes("if (input === 'n' && namedOn) {") && crew.includes('setSpawnNote(gate)'))
  const boot = src('src/components/BootSettingsScreen.tsx')
  check("the boot menu opened in-session flips a live row through the connector's one verb", boot.includes("row.applicationClass === 'live'") && boot.includes('.setSpawnSwitch(kind, spawnSwitchOnFromValue(value))') && boot.includes("action: 'set-spawn-switch'"))
  check('the concourse coordinator never reads the switch (its launches are the estate\'s, not a session\'s)', !src('src/services/concourse/coordinatorTools.ts').includes('spawnSwitch') && !src('src/services/concourse/coordinatorTools.ts').includes('launchAuthority'))
  check("the daemon's crew seats never read the switch (the concourse keeps launching crew)", !src('src/daemon/crewSpawn.ts').includes('spawnSwitch') && !src('src/daemon/crewSpawn.ts').includes('launchAuthority'))
  const owner = src('src/services/switchboard/spawnSwitches.ts')
  check('the owner attributes through realEnvPin (the one boot-env attribution owner)', owner.includes('realEnvPin(row, env) !== null'))
  const srcWalk = (dir: string): string[] => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap(e => (e.isDirectory() ? srcWalk(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : []))
  const readers = srcWalk('src').filter(f => !f.endsWith('spawnSwitches.ts') && !f.endsWith('flagRegistry.ts') && !f.endsWith('startupMenu.ts') && (src(f).includes(SUB) || src(f).includes(WF)))
  check('no second reader of the switch rows outside the owner (the registry and the menu table declare, never read — one owner per fact)', readers.length === 0, readers.join(','))
}

// ============================================================================
section("§5 the record's view — the admission snapshot's rows and the in-session toggle")
// ============================================================================
{
  const rows = (value: string | null, source: 'process-env' | 'profile' | 'default') => ({ settingsSnapshot: { rows: [{ env: SUB, value, source }] } })
  check('a profile row of 0 reads off, the boot menu\'s', j(sw.spawnSwitchOfRecord(rows('0', 'profile'), 'subagents')) === j({ on: false, source: 'boot-menu' }))
  check("a real env row reads off, the environment's", j(sw.spawnSwitchOfRecord(rows('0', 'process-env'), 'subagents')) === j({ on: false, source: 'env' }))
  check('a default row reads on', j(sw.spawnSwitchOfRecord(rows(null, 'default'), 'subagents')) === j({ on: true, source: 'default' }))
  check('a record without a snapshot reads on (a pre-switch record)', j(sw.spawnSwitchOfRecord({}, 'workflows')) === j({ on: true, source: 'default' }) && j(sw.spawnSwitchOfRecord(undefined, 'subagents')) === j({ on: true, source: 'default' }))
  check('an in-session toggle on the record outranks the snapshot', j(sw.spawnSwitchOfRecord({ ...rows('0', 'profile'), spawnSwitches: { subagents: 'on' } }, 'subagents')) === j({ on: true, source: 'in-session' }))
  check('the facts of a record carry both', j(sw.spawnSwitchFactsOfRecord({ spawnSwitches: { workflows: 'off' } })) === j({ subagents: { on: true, source: 'default' }, workflows: { on: false, source: 'in-session' } }))
  check('the lines read as the operator sees them', sw.spawnSwitchLine('subagents', { on: false, source: 'boot-menu' }) === 'sub-agents off (boot menu)' && sw.spawnSwitchLine('workflows', { on: true, source: 'in-session' }) === 'workflows on (in-session)' && sw.spawnSwitchLine('workflows', { on: false, source: 'env' }) === 'workflows off (environment)')
}

// ============================================================================
section('§6 the seat verb — idle applies, busy parks, the idle edge drains, the respawn re-forwards')
// ============================================================================
{
  const seat = await import('../../src/daemon/sessionSeat.ts')
  const sup = await import('../../src/daemon/concourseSupervisor.ts')
  const { readSessionFacts } = await import('../../src/services/engine-connector/seatProjections.ts')
  const recDir = mkdtempSync(join(tmpdir(), 'spawn-switch-records-'))
  const workspaceId = mkdtempSync(join(tmpdir(), 'spawn-switch-ws-'))
  const sid = '550e8400-e29b-41d4-a716-4466554400c3'
  const short = 'concourse-s1'
  const path = join(HOME, 'boot-env-seat.json')
  menu.saveBootDefaultsProfile({}, path)
  const snapshot = menu.resolveEffectiveSettingsSnapshot({ sessionId: sid, path, env: {} })
  sup.updateConcourseWorkers(ws => {
    ws[short] = { schema: 1, runnerId: short, sessionId: sid, workspaceId, isolation: 'exclusive', modelKey: 'claude-fable-5', spawnedAt: 1, lastLiveAt: Date.now(), settingsSnapshot: snapshot }
  }, recDir)
  let busy = false
  const frames: Array<{ subtype?: string; switch?: string; on?: boolean }> = []
  const roster = {
    control: (_short: string, frame: string): boolean => {
      const parsed = JSON.parse(frame) as { request?: { subtype?: string; switch?: string; on?: boolean } }
      frames.push({ subtype: parsed.request?.subtype, switch: parsed.request?.switch, on: parsed.request?.on })
      return true
    },
    list: () => [{ short, busy, turnActive: busy }],
    patchSeatModel: () => true,
    patchSeatEffort: () => true,
  }
  /** The facts publish is an ordered async chain: let it land. */
  const settled = (): Promise<void> => new Promise(r => setTimeout(r, 120))
  const toggles = (): Array<{ subtype?: string; switch?: string; on?: boolean }> => frames.filter(f => f.subtype === 'spawn_switch')
  const rec = (): ReturnType<typeof sup.readSessionWorkers>[string] | undefined => sup.readSessionWorkers(recDir)[short]

  const applied = seat.setSessionSpawnSwitch(sid, { kind: 'subagents', on: false }, 'operator', roster, recDir)
  check("idle: the toggle applies with the receipt (the Agent tool leaves the roster; reasoning restarts; a running spawn finishes)", applied.outcome === 'applied' && applied.detail === sw.spawnSwitchToggleReceipt('subagents', false, 'applied') && (applied.detail ?? '').includes('the Agent tool leaves the roster from the next turn') && (applied.detail ?? '').includes('reasoning restarts on the next turn') && (applied.detail ?? '').includes('a spawn already running finishes'), j(applied))
  check('…the record carries the toggle (the durable truth)', rec()?.spawnSwitches?.subagents === 'off', j(rec()?.spawnSwitches))
  check('…one spawn_switch frame reached the child', toggles().length === 1 && toggles()[0]?.switch === 'subagents' && toggles()[0]?.on === false, j(toggles()))
  await settled()
  const facts = readSessionFacts(sid, recDir)
  check("…the facts projection carries the record's view (off, in-session) and no parked toggle", facts?.spawnSwitches?.subagents.on === false && facts.spawnSwitches.subagents.source === 'in-session' && facts.spawnSwitches.workflows.on === true && facts.pendingSpawnSwitches === undefined, j(facts?.spawnSwitches))
  const same = seat.setSessionSpawnSwitch(sid, { kind: 'subagents', on: false }, 'operator', roster, recDir)
  check('the same state no-ops', same.outcome === 'noop' && same.detail === 'sub-agents already off for this session', j(same))

  busy = true
  const queued = seat.setSessionSpawnSwitch(sid, { kind: 'subagents', on: true }, 'operator', roster, recDir)
  check("busy: the toggle parks with the honest 'queued' line", queued.outcome === 'queued' && queued.detail === sw.spawnSwitchToggleReceipt('subagents', true, 'queued') && (queued.detail ?? '').includes('applies when this turn ends'), j(queued))
  check('…the record parks it and still reads off', rec()?.pendingSpawnSwitches?.length === 1 && rec()?.pendingSpawnSwitches?.[0]?.on === true && rec()?.spawnSwitches?.subagents === 'off')
  check('…no frame reached the child yet (a running spawn is never touched)', toggles().length === 1)
  await settled()
  check('…the facts say a toggle is parked', readSessionFacts(sid, recDir)?.pendingSpawnSwitches?.[0]?.on === true)
  const parkedAgain = seat.setSessionSpawnSwitch(sid, { kind: 'subagents', on: true }, 'operator', roster, recDir)
  check('the parked state decides noop (asking again for the parked value)', parkedAgain.outcome === 'noop')
  busy = false
  seat.onSeatIdle(short, roster, recDir)
  check('the idle edge drains the parked toggle: the record reads on, nothing parked', rec()?.spawnSwitches?.subagents === 'on' && rec()?.pendingSpawnSwitches === undefined, j(rec()?.spawnSwitches))
  check('…and the child hears it', toggles().length === 2 && toggles()[1]?.on === true, j(toggles()))
  const before = toggles().length
  seat.onSeatSpawned(short, roster, recDir)
  check("the respawn re-forwards the record's toggles to the fresh child", toggles().length === before + 1 && toggles()[before]?.switch === 'subagents' && toggles()[before]?.on === true, j(toggles()))
  const unknown = seat.setSessionSpawnSwitch('no-such-session', { kind: 'workflows', on: false }, 'operator', roster, recDir)
  check('an unknown session refuses typed', unknown.outcome === 'refused' && (unknown.detail ?? '').includes('unknown-session'))
  const daemonMain = src('src/daemon/main.ts')
  check("the daemon's control dispatcher routes 'set-spawn-switch' to the seat verb", daemonMain.includes("if (action === 'set-spawn-switch')") && daemonMain.includes('setSessionSpawnSwitch(sessionId, spawnSwitch, by, roster)'))
  check('the control server admits the action and narrows the payload', src('src/daemon/controlServer.ts').includes("raw.action === 'set-spawn-switch'") && src('src/daemon/controlServer.ts').includes("spawnSwitch refused — { kind: subagents|workflows, on: boolean }"))
  const printSrc = src('src/cli/print.ts')
  check("the runner lands 'spawn_switch' now when idle and defers a mid-turn one to the turn's end", printSrc.includes("case 'spawn_switch': {") && printSrc.includes('deferredSpawnSwitches = [...deferredSpawnSwitches.filter(d => d.kind !== toggle.kind), toggle]') && printSrc.includes('for (const toggle of toggles) landSpawnSwitch(toggle.kind, toggle.on)'))
  check('…the landing moves the switch and marks the transition row', printSrc.includes('const landed = setSpawnSwitch(kind, on)') && printSrc.includes('messages.push(createRosterTransitionMessage(kind, on, spawnSwitchTransitionLine(kind, on)))'))
  check("the runner's facts carry its switches", printSrc.includes('spawnSwitches: spawnSwitchFacts(),'))
}

// ============================================================================
section('§7 the preserved-thinking seam — a roster transition is a lawful prefix change that names the toggle')
// ============================================================================
{
  const tb = await import('../../src/services/providers/anthropic/thinkingBinding.ts')
  const { createRosterTransitionMessage } = await import('../../src/utils/messages/systemMessages.ts')
  const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages/factories.ts')
  const DROP = { type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' } as const
  const history = [createUserMessage({ content: 'hi' }), createAssistantMessage({ content: 'hello' })]
  const mark0 = tb.prefixMarkOf(history as never, 'claude-fable-5-1')
  check('no roster transition ⇒ the mark carries none', mark0.rosterTransition === null && mark0.rosterChange === null)
  const row = createRosterTransitionMessage('subagents', false, sw.spawnSwitchTransitionLine('subagents', false))
  check("the row's sentence names the operator's toggle and the boundary", row.content.includes('the operator toggled sub-agents off for this session') && row.content.includes('reasoning restarts on the next turn') && row.subtype === 'roster_transition' && row.toggle === 'subagents' && row.on === false)
  const mark1 = tb.prefixMarkOf([...history, row] as never, 'claude-fable-5-1')
  check("the newest roster transition marks the prefix with the toggle's word", mark1.rosterTransition === row.uuid && mark1.rosterChange === 'sub-agents off' && mark1.firstRow === mark0.firstRow && mark1.model === mark0.model)
  tb.resetThinkingDropStates()
  const none = tb.classifyThinkingDrops('owner', [], mark0)
  check('a no-drop response records the mark', none.kind === 'none' && none.rosterChange === null)
  const lawful = tb.classifyThinkingDrops('owner', [DROP], mark1)
  check("a drop after the toggle reads LAWFUL as a roster switch", lawful.kind === 'lawful' && lawful.lawful === 'roster-switch' && lawful.rosterChange === 'sub-agents off' && lawful.consecutive === 1, j(lawful))
  const notice = tb.describeThinkingDrops([DROP], lawful) ?? ''
  check('…the notice names the toggle, expected once — never a client-side edit, never a Mercury defect', notice.includes('after the operator toggled sub-agents off') && notice.includes('the tool roster changed with it') && notice.includes('(expected once)') && !notice.includes('client-side') && !notice.includes('Mercury defect'), notice)
  const after = tb.classifyThinkingDrops('owner', [DROP], mark1)
  check('a lawful drop never seeds a run: the next drop with the same marks is a first drop', after.kind === 'first' && after.consecutive === 1, j(after))
  const health = tb.preservedThinkingHealth({ last: { at: '2026-01-01T00:00:00.000Z', kind: 'lawful', lawful: 'roster-switch', reason: DROP.reason, path: DROP.path, count: 3, consecutive: 1, model: 'claude-fable-5-1' }, longestRun: 0 })
  check("the doctor ledger's wording names the spawn-switch toggle", health.status === 'info' && health.evidence.includes("the operator's spawn-switch toggle") && health.evidence.includes('expected once'), health.evidence)
  check("a model switch's wording is untouched", tb.preservedThinkingHealth({ last: { at: 'x', kind: 'lawful', lawful: 'model-switch', reason: DROP.reason, path: DROP.path, count: 1, consecutive: 1, model: 'm' }, longestRun: 0 }).evidence.includes('after a model switch'))
  check('the row is UI-only: the API view never carries a roster transition', !src('src/utils/messages/apiPlan.ts').includes('roster_transition') && src('src/utils/messages/apiPlan.ts').includes("m.type === 'system' && !isSystemLocalCommandMessage(m)"))
}

// ============================================================================
//  The artifact legs — the real bundle against the fixture API.
// ============================================================================
const nodeBin = Bun.which('node')
if (!existsSync(DIST)) {
  check('dist/mercury.mjs present (build first; the pooled gate prebuilds it)', false, DIST)
} else if (!nodeBin) {
  check('a node binary on PATH', false)
} else {
  const { startFixtureApi } = await import('../lib/fixtureApi.ts')
  type ScriptedTurn = Parameters<typeof startFixtureApi>[0][number]
  interface Arena { home: string; cwd: string; env: Record<string, string> }
  function makeArena(baseUrl: string, extraEnv: Record<string, string> = {}): Arena {
    const home = mkdtempSync(join(tmpdir(), 'spawn-switch-wire-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'spawn-switch-wire-cwd-'))
    mkdirSync(join(home, '.claude'), { recursive: true })
    return {
      home,
      cwd,
      env: {
        HOME: home,
        PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
        TERM: 'dumb',
        MERCURY_CONFIG_DIR: join(home, '.claude'),
        MERCURY_CREDENTIAL_STORE: 'file',
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_API_KEY: 'fixture-key-000',
        MERCURY_DAEMON_DIR: join(home, 'daemon'),
        MERCURY_TEAMS_DIR: join(home, 'teams'),
        MERCURY_THINKING_BINDING: 'drop_block',
        ...extraEnv,
      },
    }
  }
  interface RunResult { exit: number | null; stdout: string; stderr: string }
  /** One process over the stream-json input road: each turn's prompt is
   *  written after the previous result envelope; a turn may send a control
   *  request first (the daemon's own frame shape). */
  function runStreaming(arena: Arena, args: string[], turns: Array<{ prompt: string; control?: Record<string, unknown> }>): Promise<RunResult> {
    return new Promise(resolvePromise => {
      const child = spawn(nodeBin, [DIST, ...args], { cwd: arena.cwd, env: arena.env })
      let stdout = ''
      let stderr = ''
      let sent = 0
      let resultsSeen = 0
      const sendNext = (): void => {
        if (sent >= turns.length) {
          child.stdin.end()
          return
        }
        const turn = turns[sent]!
        sent++
        if (turn.control !== undefined) child.stdin.write(j({ type: 'control_request', request_id: `spawn-switch-${sent}`, request: turn.control }) + '\n')
        child.stdin.write(j({ type: 'user', message: { role: 'user', content: turn.prompt } }) + '\n')
      }
      child.stdout.on('data', d => {
        stdout += d
        const results = stdout.split('\n').filter(l => l.includes('"type":"result"')).length
        while (resultsSeen < results) {
          resultsSeen++
          sendNext()
        }
      })
      child.stderr.on('data', d => (stderr += d))
      const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
      child.on('close', exit => {
        clearTimeout(killer)
        resolvePromise({ exit, stdout, stderr })
      })
      child.on('spawn', () => sendNext())
    })
  }
  type Body = { system?: unknown; tools?: Array<{ name?: string }>; messages?: unknown[] }
  const withoutCacheControl = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutCacheControl)
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (k !== 'cache_control') out[k] = withoutCacheControl(v)
      return out
    }
    return value
  }
  const toolNames = (body: Body): string[] => (body.tools ?? []).map(t => String(t.name ?? ''))
  function transcriptNotices(arena: Arena, sessionId: string): string[] {
    const walk = (dir: string): string[] => {
      const out: string[] = []
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) out.push(...walk(full))
        else if (entry.name === `${sessionId}.jsonl`) out.push(full)
      }
      return out
    }
    const files = existsSync(join(arena.home, '.claude', 'projects')) ? walk(join(arena.home, '.claude', 'projects')) : []
    const notices: string[] = []
    for (const file of files) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.includes('Preserved thinking')) continue
        try {
          const row = JSON.parse(line) as { payload?: { kind?: string; content?: string } }
          if (row.payload?.kind === 'notice' && typeof row.payload.content === 'string') notices.push(row.payload.content)
        } catch {
          // not a row
        }
      }
    }
    return notices
  }
  const common = ['-p', '--input-format', 'stream-json', '--model', 'claude-opus-4-8', '--output-format', 'stream-json', '--verbose']

  // --------------------------------------------------------------------------
  section('§8a the wire — born with both switches off, the request carries neither tool')
  // --------------------------------------------------------------------------
  {
    const turns: ScriptedTurn[] = [{ kind: 'text', text: 'S8A-DONE', thinking: 'born off', inputTransformations: [] }]
    const fixture = await startFixtureApi(turns)
    const arena = makeArena(fixture.url, { [SUB]: '0', [WF]: '0' })
    const r = await runStreaming(arena, common, [{ prompt: 'hi' }])
    check('the process exits 0 and answers', r.exit === 0 && r.stdout.includes('S8A-DONE'), `exit=${r.exit} stderr=${r.stderr.slice(0, 300)}`)
    const reqs = fixture.messageRequests()
    const names = reqs.length > 0 ? toolNames(reqs[0]!.body as Body) : []
    check('the first request carries no Agent tool and no Workflow tool', reqs.length >= 1 && !names.includes(AgentTool.name) && !names.includes(WorkflowTool.name) && names.includes('Read'), names.join(','))
    await fixture.close()
  }

  // --------------------------------------------------------------------------
  section('§8b the wire — the in-session toggle moves the roster at the next request, the prefix holds, the receipt names the toggle')
  // --------------------------------------------------------------------------
  {
    const DROP = { type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' }
    const turns: ScriptedTurn[] = [
      { kind: 'text', text: 'S8B-TURN-1-DONE', thinking: 'first', inputTransformations: [] },
      { kind: 'text', text: 'S8B-TURN-2-DONE', thinking: 'after the toggle', inputTransformations: [DROP] },
      { kind: 'text', text: 'S8B-TURN-3-DONE', thinking: 'third', inputTransformations: [] },
    ]
    const fixture = await startFixtureApi(turns)
    const arena = makeArena(fixture.url)
    const SID = 'c0ffee00-0000-4000-8000-0000000005b8'
    const r = await runStreaming(arena, [...common, '--session-id', SID], [
      { prompt: 'hi one' },
      { prompt: 'hi two', control: { subtype: 'spawn_switch', switch: 'subagents', on: false } },
      { prompt: 'hi three' },
    ])
    check('the three-turn process exits 0 and answers every turn', r.exit === 0 && r.stdout.includes('S8B-TURN-1-DONE') && r.stdout.includes('S8B-TURN-2-DONE') && r.stdout.includes('S8B-TURN-3-DONE'), `exit=${r.exit} stderr=${r.stderr.slice(0, 400)}`)
    check('the runner acknowledged the toggle (a control_response success)', r.stdout.split('\n').some(l => l.includes('"type":"control_response"') && l.includes('spawn-switch-2') && l.includes('"subtype":"success"')), r.stdout.split('\n').filter(l => l.includes('control_response')).join(' | ').slice(0, 400))
    const reqs = fixture.messageRequests()
    check('three message requests', reqs.length === 3, String(reqs.length))
    if (reqs.length === 3) {
      const b1 = reqs[0]!.body as Body
      const b2 = reqs[1]!.body as Body
      const b3 = reqs[2]!.body as Body
      check('request 1 carries the Agent tool', toolNames(b1).includes(AgentTool.name), toolNames(b1).join(','))
      check('request 2 (the next request after the toggle) carries no Agent tool — the roster changed on the wire', !toolNames(b2).includes(AgentTool.name), toolNames(b2).join(','))
      check('…and nothing else left the tools array', j(toolNames(b1).filter(n => n !== AgentTool.name)) === j(toolNames(b2)))
      const pm = (b1.messages ?? []) as unknown[]
      const cm = (b2.messages ?? []) as unknown[]
      const prefixSame = pm.every((m, i) => j(withoutCacheControl(m)) === j(withoutCacheControl(cm[i])))
      check('the shared messages prefix is byte-identical and the turn is appended (the toggle is a roster change, never a history rewrite)', prefixSame && cm.length > pm.length, `${pm.length}→${cm.length}`)
      // The lawful-change seam re-evaluates the memoized prompt sections with
      // the roster, so the top-level system may move WITH the toggle — once:
      // request 3 (no further change) is byte-identical to request 2.
      check('the top-level system moves at most at the toggle: request 3 is byte-identical to request 2', j(withoutCacheControl(b2.system)) === j(withoutCacheControl(b3.system)))
      check('request 3 keeps the toggled roster (sticky)', !toolNames(b3).includes(AgentTool.name) && j(toolNames(b2)) === j(toolNames(b3)))
    }
    const notices = transcriptNotices(arena, SID)
    check('the scripted drop paints exactly one receipt', notices.length === 1, `${notices.length} ${notices[0]?.slice(0, 200) ?? ''}`)
    const notice = notices[0] ?? ''
    check("…the receipt names the operator's toggle, expected once — never a client-side edit, never Mercury", notice.includes('after the operator toggled sub-agents off') && notice.includes('(expected once)') && !notice.includes('client-side') && !notice.includes('Mercury defect'), notice.slice(0, 300))
    await fixture.close()
  }

  // --------------------------------------------------------------------------
  section('§9 the doctor — the built artifact names both switches with their source')
  // --------------------------------------------------------------------------
  {
    const findRow = (value: unknown): Record<string, unknown> | null => {
      if (Array.isArray(value)) {
        for (const item of value) {
          const hit = findRow(item)
          if (hit !== null) return hit
        }
        return null
      }
      if (value !== null && typeof value === 'object') {
        const record = value as Record<string, unknown>
        if (record.id === 'spawn-switches') return record
        for (const inner of Object.values(record)) {
          const hit = findRow(inner)
          if (hit !== null) return hit
        }
      }
      return null
    }
    const doctor = (extraEnv: Record<string, string>): Record<string, unknown> | null => {
      const home = mkdtempSync(join(tmpdir(), 'spawn-switch-doctor-'))
      const configDir = join(home, '.mercury')
      mkdirSync(configDir, { recursive: true })
      const out = spawnSync(nodeBin, [DIST, 'doctor', '--json', '--only', 'spawn-switches'], {
        cwd: home,
        env: { HOME: home, PATH: `/usr/bin:/bin:${dirname(nodeBin)}`, TERM: 'dumb', MERCURY_CONFIG_DIR: configDir, MERCURY_CREDENTIAL_STORE: 'file', ANTHROPIC_API_KEY: 'fixture-key-000', ...extraEnv },
        encoding: 'utf8',
        timeout: 60_000,
      })
      const text = out.stdout.trim()
      try {
        return findRow(JSON.parse(text))
      } catch {
        console.log(`    doctor stdout: ${text.slice(0, 300)} stderr: ${out.stderr.slice(0, 300)}`)
        return null
      }
    }
    const clean = doctor({})
    check('a clean process: both on, the defaults, ok', clean !== null && clean.status === 'ok' && String(clean.evidence).includes('sub-agents on (default)') && String(clean.evidence).includes('workflows on (default)') && String(clean.evidence).includes('the next session is born with these'), j(clean))
    const off = doctor({ [SUB]: '0' })
    check("sub-agents off in the environment: the row says so with its source, info, and names the commands and the menu", off !== null && off.status === 'info' && String(off.evidence).includes('sub-agents off (environment)') && String(off.evidence).includes('workflows on (default)') && String(off.detail ?? '').includes('/subagents on|off') && String(off.detail ?? '').includes("boot menu's Agents section") && off.label === 'Sub-agents & workflows', j(off))
  }
}

// ============================================================================
section('§10 the commands — /subagents and /workflows on|off, the grammar, the no-chat sentence')
// ============================================================================
{
  const { default: subagents } = await import('../../src/commands/subagents/index.ts')
  const { default: workflows } = await import('../../src/commands/workflows/index.ts')
  const { COMMAND_DOMAINS } = await import('../../src/components/HelpV2/commandDomains.ts')
  const { runSpawnSwitchCommand } = await import('../../src/commands/subagents/subagents.ts')
  const { commandSeat, builtinCommands } = await import('../../src/commands.ts')
  check('/subagents is a screen-seat local command with the on|off hint', subagents.type === 'local' && subagents.name === 'subagents' && subagents.seat === 'screen' && subagents.argumentHint === '[on|off]' && commandSeat(subagents as never) === 'screen')
  check('/subagents is registered in the command table', builtinCommands().some(c => c.name === 'subagents'))
  check('/workflows carries the on|off hint and stays the board', workflows.type === 'local-jsx' && workflows.argumentHint === '[on|off]' && String(workflows.description).includes('on|off'))
  check('/subagents sits in the crew & delegation domain beside /workflows', COMMAND_DOMAINS.find(d => d.key === 'crew')?.names.includes('subagents') === true && COMMAND_DOMAINS.find(d => d.key === 'crew')?.names.includes('workflows') === true)
  check('the README roster names /subagents in crew & delegation', /\| crew & delegation \|[^\n]*`\/subagents`/.test(src('README.md')))
  check('the grammar: on · off · empty · junk', j(sw.parseSpawnSwitchArg(' ON ')) === j({ op: 'on' }) && j(sw.parseSpawnSwitchArg('off')) === j({ op: 'off' }) && j(sw.parseSpawnSwitchArg('')) === j({ op: 'show' }) && j(sw.parseSpawnSwitchArg('maybe')) === j({ op: 'unknown', word: 'maybe' }))
  const usage = await runSpawnSwitchCommand('workflows', 'maybe')
  check('junk answers the usage line naming the command', usage.startsWith('usage: /workflows on|off'), usage)
  const noChat = await runSpawnSwitchCommand('subagents', 'off')
  check('no chat open ⇒ the one sentence naming the focused session and the menu', noChat.includes('no chat is open') && noChat.includes("the boot menu's Agents section"), noChat)
  check('the workflows board branches on the argument through the same body', src('src/commands/workflows/workflows.tsx').includes("runSpawnSwitchCommand('workflows'") && src('src/commands/workflows/workflows.tsx').includes('parseSpawnSwitchArg(args'))
  check('the toggle receipts read the daemon\'s vocabulary', sw.spawnSwitchToggleReceipt('workflows', false, 'refused', 'no live channel') === 'workflows off refused — no live channel' && sw.spawnSwitchToggleReceipt('workflows', true, 'applied').includes('the Workflow tool rejoins the roster from the next turn'))
  check("the changelog and the agents page carry the switches", src('src/constants/changelog.ts').includes('/subagents on|off') && src('docs/TEAMS.md').includes('## The two spawn switches'))
}

console.log(`\n${failures === 0 ? '✅' : '❌'} prove-spawn-switch — ${checks - failures}/${checks} checks passed`)
clearTimeout(guard)
process.exit(failures === 0 ? 0 : 1)
