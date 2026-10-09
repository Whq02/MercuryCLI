;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const HOME = mkdtempSync(join(tmpdir(), 'switchboard-bglaunch-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.MERCURY_HOME
delete process.env.MERCURY_CONCOURSE_WORKER
delete process.env.NODE_ENV

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const j = (v: unknown): string => JSON.stringify(v)
const ROOT = join(import.meta.dirname, '../..')
const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

type Kind = 'subagents' | 'workflows'
const KINDS: Kind[] = ['subagents', 'workflows']

const { focusConcourseSession, grantConcourseWorkflows, readSessionWorkers, revokeConcourseWorkflows, updateConcourseWorkers } = await import('../../src/daemon/concourseWorkers.js')
const { evaluateLaunchAuthority } = await import('../../src/services/switchboard/launchAuthority.js')
const { spawnSwitchOffReceipt } = await import('../../src/services/switchboard/spawnSwitches.js')

type Setting = {
  BACKGROUND_LAUNCH_KEY: string
  BACKGROUND_LAUNCH_LABEL: string
  backgroundSessionsLaunchCrewmates: () => boolean
  setBackgroundSessionsLaunchCrewmates: (on: boolean) => boolean
  backgroundLaunchReceiptWords: (on: boolean) => string
  BACKGROUND_LAUNCH_MENU_ROW: { env: string; group: string; kind: string; options: readonly string[]; defaultLabel: string; applicationClass?: string; label: string }
}
let setting: Setting | null = null
try {
  setting = (await import('../../src/services/switchboard/backgroundLaunch.js')) as unknown as Setting
} catch (error) {
  console.log(`  (the setting module is absent on this tree: ${error instanceof Error ? error.message.split('\n')[0] : String(error)})`)
}
const LABEL = setting?.BACKGROUND_LAUNCH_LABEL ?? 'Crewmates while backgrounded'

const recDir = mkdtempSync(join(tmpdir(), 'switchboard-bglaunch-records-'))
const workspaceId = mkdtempSync(join(tmpdir(), 'switchboard-bglaunch-ws-'))
const sidA = '550e8400-e29b-41d4-a716-4466554400c1'
const sidB = '550e8400-e29b-41d4-a716-4466554400d2'
const seat = `operator:${process.pid}`
updateConcourseWorkers(ws => {
  ws['concourse-w1'] = { schema: 1, runnerId: 'concourse-w1', sessionId: sidA, workspaceId, isolation: 'exclusive', modelKey: 'claude-fable-5', spawnedAt: 1, lastLiveAt: Date.now() }
  ws['concourse-w2'] = { schema: 1, runnerId: 'concourse-w2', sessionId: sidB, workspaceId, isolation: 'exclusive', modelKey: 'claude-fable-5', spawnedAt: 1, lastLiveAt: Date.now() }
}, recDir)

const probe = (sid: string, kind: Kind, settingOn: boolean, extra: Record<string, unknown> = {}) =>
  evaluateLaunchAuthority(kind, { roleEnvOn: true, dir: recDir, sessionId: sid, settingOn, ...extra } as never)
const refusalRoads = (reason: string): boolean =>
  reason.startsWith('this session is backgrounded — ') &&
  reason.includes('wait until the operator visits it') &&
  reason.includes('until it holds the workflows-allowed tag (granted by asking the coordinator, choosing keep-and-background on leave, or the manual-start option)') &&
  reason.includes(`or until the operator turns on ${LABEL} (/config, or the boot menu's Agents section)`) &&
  reason.endsWith('Keep working on the task single-handed.')

console.log('LAW 1 — the truth table: switch × role × focus × tag × setting')
{
  for (const kind of KINDS) {
    const off = evaluateLaunchAuthority(kind, { roleEnvOn: true, dir: recDir, sessionId: sidA, settingOn: true, spawnSwitch: { on: false, source: 'in-session' } } as never)
    check(`${kind}: the session's own switch off refuses with the switch receipt whatever the setting says`, !off.allowed && off.cause === 'session-switch' && off.reason === spawnSwitchOffReceipt(kind), j(off))
    const plain = evaluateLaunchAuthority(kind, { roleEnvOn: false, settingOn: false } as never)
    check(`${kind}: an interactive process launches as itself whatever the setting says`, plain.allowed && plain.posture === 'attached-or-plain', j(plain))
    const byOff = probe(sidA, kind, false)
    check(`${kind}: backgrounded + unfocused + untagged + setting OFF is refused as backgrounded`, !byOff.allowed && byOff.cause === 'backgrounded', j(byOff))
    check(`${kind}: the refusal names the three roads — the visit, the tag, and the ${LABEL} row of /config`, !byOff.allowed && refusalRoads(byOff.reason), j(byOff))
    const byOn = probe(sidA, kind, true)
    check(`${kind}: backgrounded + unfocused + untagged + setting ON launches with the posture background-by-setting`, byOn.allowed && byOn.posture === 'background-by-setting', j(byOn))
  }
  check('focus applies on A', focusConcourseSession(sidA, seat, recDir).outcome === 'applied')
  const focused = probe(sidA, 'subagents', true)
  check('focused outranks the setting (posture focused)', focused.allowed && focused.posture === 'focused', j(focused))
  check('grant applies on B', grantConcourseWorkflows(sidB, 'operator', recDir).outcome === 'applied')
  const tagged = probe(sidB, 'workflows', true)
  check('the tag outranks the setting (posture tagged-background)', tagged.allowed && tagged.posture === 'tagged-background', j(tagged))
  const second = grantConcourseWorkflows(sidA, 'coordinator', recDir)
  check('the one-tag cap is untouched: a second grant is still refused cap-one', second.outcome === 'refused' && 'reason' in second && second.reason === 'cap-one', j(second))
  check('revoke applies on B', revokeConcourseWorkflows(sidB, 'operator', recDir).outcome === 'applied')
  const deadPid = spawnSync('true').pid!
  updateConcourseWorkers(ws => {
    ws['concourse-w2']!.focusedAt = Date.now()
    ws['concourse-w2']!.focusedBy = `operator:${deadPid}`
  }, recDir)
  const deadSeatOn = probe(sidB, 'subagents', true)
  const deadSeatOff = probe(sidB, 'subagents', false)
  check('a dead seat is no seat: the setting still admits (background-by-setting)', deadSeatOn.allowed && deadSeatOn.posture === 'background-by-setting', j(deadSeatOn))
  check('a dead seat with the setting off is refused as backgrounded', !deadSeatOff.allowed && deadSeatOff.cause === 'backgrounded', j(deadSeatOff))
  updateConcourseWorkers(ws => {
    ws['concourse-w2']!.endedAt = Date.now()
  }, recDir)
  const ended = probe(sidB, 'subagents', true)
  check("an ended record is nobody's seat, but the setting is the operator's standing word: admits by setting", ended.allowed && ended.posture === 'background-by-setting', j(ended))
  const unreadable = mkdtempSync(join(tmpdir(), 'switchboard-bglaunch-garbage-'))
  writeFileSync(join(unreadable, 'concourse-workers.json'), '{not json')
  const garbageOn = evaluateLaunchAuthority('subagents', { roleEnvOn: true, dir: unreadable, sessionId: sidA, settingOn: true } as never)
  const garbageOff = evaluateLaunchAuthority('subagents', { roleEnvOn: true, dir: unreadable, sessionId: sidA, settingOn: false } as never)
  check('unreadable records: the setting still admits', garbageOn.allowed && garbageOn.posture === 'background-by-setting', j(garbageOn))
  check('unreadable records with the setting off: refused as backgrounded', !garbageOff.allowed && garbageOff.cause === 'backgrounded', j(garbageOff))
  check('the records survived the probes (A focused, B ended)', readSessionWorkers(recDir)['concourse-w1']?.focusedBy === seat && readSessionWorkers(recDir)['concourse-w2']?.endedAt !== undefined)
}

console.log('LAW 2 — the one leaf: off by default, read live, absent when off')
{
  const { enableConfigs, getGlobalConfig } = await import('../../src/utils/config.js')
  const schema = await import('../../src/utils/config/schema.js')
  enableConfigs()
  check('the setting module exists', setting !== null)
  check('the leaf is on the global-config key allowlist', (schema.GLOBAL_CONFIG_KEYS as readonly string[]).includes('backgroundSessionsLaunchCrewmates') && schema.isGlobalConfigKey('backgroundSessionsLaunchCrewmates'))
  check('the default config mints no value for it (absent = off)', !('backgroundSessionsLaunchCrewmates' in (schema.createDefaultGlobalConfig() as Record<string, unknown>)))
  check('a fresh home reads OFF', setting?.backgroundSessionsLaunchCrewmates() === false)
  const live = evaluateLaunchAuthority('subagents', { roleEnvOn: true, dir: recDir, sessionId: sidB } as never)
  check('the unprobed read on a fresh home refuses (the setting is off)', !live.allowed && live.cause === 'backgrounded', j(live))
  setting?.setBackgroundSessionsLaunchCrewmates(true)
  check('turned on through its one writer, the leaf reads ON', setting?.backgroundSessionsLaunchCrewmates() === true && (getGlobalConfig() as Record<string, unknown>).backgroundSessionsLaunchCrewmates === true)
  const file = JSON.parse(readFileSync(join(HOME, '.mercury.json'), 'utf8')) as Record<string, unknown>
  check('the file carries the leaf as true', file.backgroundSessionsLaunchCrewmates === true, j(file))
  const liveOn = evaluateLaunchAuthority('subagents', { roleEnvOn: true, dir: recDir, sessionId: sidB } as never)
  check('the unprobed read now admits by setting', liveOn.allowed && liveOn.posture === 'background-by-setting', j(liveOn))
  for (const kind of KINDS) {
    const k = evaluateLaunchAuthority(kind, { roleEnvOn: true, dir: recDir, sessionId: sidB } as never)
    check(`${kind}: the live setting admits both kinds`, k.allowed && k.posture === 'background-by-setting', j(k))
  }
  setting?.setBackgroundSessionsLaunchCrewmates(false)
  const after = JSON.parse(readFileSync(join(HOME, '.mercury.json'), 'utf8')) as Record<string, unknown>
  check('turned off, the key leaves the file (absent = off, never a stored false)', !('backgroundSessionsLaunchCrewmates' in after), j(after))
  check('and the valve refuses again', !evaluateLaunchAuthority('subagents', { roleEnvOn: true, dir: recDir, sessionId: sidB } as never).allowed)
  const { decodeGlobalConfigFields } = await import('../../src/utils/config/globalConfig.js')
  const decoded = decodeGlobalConfigFields({ backgroundSessionsLaunchCrewmates: 'yes', numStartups: 1 }) as Record<string, unknown>
  check('a stored value that is not a boolean is dropped at the read door (the field-shape guard)', !('backgroundSessionsLaunchCrewmates' in decoded), j(decoded))
  check('the receipt words say what the switch does, on and off', setting !== null && setting.backgroundLaunchReceiptWords(true).startsWith(`${LABEL} on — `) && setting.backgroundLaunchReceiptWords(false).startsWith(`${LABEL} off — `))
}

console.log('LAW 3 — the source pins')
{
  const valve = src('src/services/switchboard/launchAuthority.ts')
  const focusedArmAt = valve.indexOf("posture: 'focused'")
  const tagArmAt = valve.indexOf("posture: 'tagged-background'")
  const settingArmAt = valve.indexOf("posture: 'background-by-setting'")
  check('the valve carries the setting arm after the focused arm and the tag arm', focusedArmAt !== -1 && tagArmAt !== -1 && settingArmAt !== -1 && focusedArmAt < tagArmAt && tagArmAt < settingArmAt)
  check('the setting arm reads the one reader', valve.includes('backgroundSessionsLaunchCrewmates()'))
  check("the session's own switch is still read first", valve.indexOf("cause: 'session-switch'") < valve.indexOf('flagEnv(\'MERCURY_CONCOURSE_WORKER\')'))
  check('the refusal is minted in one place and names the setting by its row label', valve.includes('export function backgroundedLaunchRefusal(') && valve.includes('${BACKGROUND_LAUNCH_LABEL}'))
  const row = setting?.BACKGROUND_LAUNCH_MENU_ROW
  check("the boot-menu row descriptor: the agents group, a live toggle, off by default, keyed by the leaf", row !== undefined && row.group === 'agents' && row.kind === 'toggle' && row.defaultLabel === 'off' && row.applicationClass === 'live' && row.env === 'backgroundSessionsLaunchCrewmates' && row.label === LABEL, j(row))
  const workers = src('src/daemon/concourseWorkers.ts')
  const grantStart = workers.indexOf('export function grantConcourseWorkflows(')
  const grantBody = workers.slice(grantStart, workers.indexOf('\n}\n', grantStart))
  check('the tag grant never reads the setting (the one-tag cap stays what it is)', grantStart !== -1 && !grantBody.includes('backgroundSessionsLaunchCrewmates'))
  for (const [file, needle] of [
    ['src/tools/AgentTool/AgentTool.tsx', "evaluateLaunchAuthority('subagents')"],
    ['src/tools/WorkflowTool/WorkflowTool.tsx', "evaluateLaunchAuthority('workflows')"],
    ['src/tools/WorkflowTool/agentHooks.ts', "evaluateLaunchAuthority('subagents')"],
    ['src/tools/SkillTool/SkillTool.ts', "evaluateLaunchAuthority('subagents')"],
  ] as const) {
    check(`${file} still asks the valve (no second gate)`, src(file).includes(needle) && !src(file).includes('backgroundSessionsLaunchCrewmates'))
  }
}

console.log(failures === 0 ? '\nprove-background-launch: ALL LAWS HOLD' : `\nprove-background-launch: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
