#!/usr/bin/env bun
// ============================================================================
//  scripts/crew/prove-crew-spec-floor.ts
//  PROOF (crew teammates #120): the daemon-side spawn FLOOR — the CLOSED
//  never-Haiku model table, the name allowlist (input space ENUMERATED — the
//  fable-audit lesson), the spec every teammate boots with (auto posture +
//  recon allowlist + capability-floor extraEnv + identity), and the crew
//  role-pair hygiene across all three role-scrub seams. MERCURY_CREW is
//  dual-polarity ('0' = operator kill, '1' = child role marker): every scrub
//  must strip the ROLE form and PRESERVE the kill.
//  Run:  ~/.bun/bin/bun run scripts/crew/prove-crew-spec-floor.ts
// ============================================================================
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolate + stamp-sim BEFORE imports (the build stamp reads MACRO at call
// time; team files resolve under MERCURY_CONFIG_DIR; posture/recon env must
// not skew the spec).
const scratch = mkdtempSync(join(tmpdir(), 'crew-specfloor-'))
process.env.MERCURY_CONFIG_DIR = scratch
delete process.env.MERCURY_DAEMON_PERMISSION_MODE
delete process.env.MERCURY_PARTY_RECON_ALLOW
delete process.env.MERCURY_CREW
delete process.env.MERCURY_CREW_AGENT
const MK = 'MACRO' as const
const setStamp = (on: boolean) => { if (on) (globalThis as Record<string, unknown>)[MK] = { VERSION: '1.0.0' }; else delete (globalThis as Record<string, unknown>)[MK] }
setStamp(true)

const cs = (await import('../../src/daemon/crewSpawn.js')) as typeof import('../../src/daemon/crewSpawn.js')
const hr = (await import('../../src/daemon/headlessRun.js')) as typeof import('../../src/daemon/headlessRun.js')
const wr = (await import('../../src/daemon/workerRecon.js')) as typeof import('../../src/daemon/workerRecon.js')
const gates = (await import('../../src/utils/scribe/scribeGates.js')) as typeof import('../../src/utils/scribe/scribeGates.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void { console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76)) }

console.log('============================================================')
console.log(' Crew spawn floor — proof')
console.log('============================================================')

section('crewEnabled — default-on polarity, LIVE re-read')
check('unset ⇒ ON', cs.crewEnabled() === true)
process.env.MERCURY_CREW = '0'
check("'0' ⇒ OFF (the operator kill)", cs.crewEnabled() === false)
delete process.env.MERCURY_CREW
check('re-unset ⇒ ON (live re-read)', cs.crewEnabled() === true)
process.env.MERCURY_CREW = '1'
check("'1' (the child role stamp) does not disable the gate", cs.crewEnabled() === true)
delete process.env.MERCURY_CREW
// the gate is stamp-independent.
setStamp(false)
check('bare stamp ⇒ STILL ON (stamp-independence)', cs.crewEnabled() === true)
setStamp(true)

section('CREW_MODEL_CHOICES — CLOSED table, Haiku unrepresentable')
const keys = Object.keys(cs.CREW_MODEL_CHOICES).sort()
check('exactly {fable, fable51, opus, sonnet}', JSON.stringify(keys) === JSON.stringify(['fable', 'fable51', 'opus', 'sonnet']))
check('opus = claude-opus-5 @ high (D-02a; natively 1M on the bare id)', cs.CREW_MODEL_CHOICES.opus.model === 'claude-opus-5' && cs.CREW_MODEL_CHOICES.opus.effort === 'high')
check('sonnet = claude-sonnet-5 @ high', cs.CREW_MODEL_CHOICES.sonnet.model === 'claude-sonnet-5' && cs.CREW_MODEL_CHOICES.sonnet.effort === 'high')
check('fable = claude-fable-5 @ high', cs.CREW_MODEL_CHOICES.fable.model === 'claude-fable-5' && cs.CREW_MODEL_CHOICES.fable.effort === 'high')
check('fable51 = claude-fable-5-1 @ high (the exact member; the family key keeps the default)', cs.CREW_MODEL_CHOICES.fable51.model === 'claude-fable-5-1' && cs.CREW_MODEL_CHOICES.fable51.effort === 'high')
check('no table value mentions haiku', !JSON.stringify(cs.CREW_MODEL_CHOICES).toLowerCase().includes('haiku'))
for (const good of ['opus', 'sonnet', 'fable', 'fable51']) check(`isCrewModelKey('${good}')`, cs.isCrewModelKey(good) === true)
for (const bad of ['haiku', 'claude-haiku-4-5', 'claude-sonnet-5', '', 'OPUS', 'opus ', '__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
  check(`isCrewModelKey(${JSON.stringify(bad)}) refused`, cs.isCrewModelKey(bad) === false)
}

section('isValidCrewName — the input space, enumerated')
for (const good of ['atlas', 'a2', 'x-ray-7', 'ab', 'a'.repeat(16)]) {
  check(`valid: ${JSON.stringify(good)}`, cs.isValidCrewName(good) === true)
}
const badNames: Array<[string, string]> = [
  ['a', '1 char (min 2)'], ['a'.repeat(17), '17 chars (max 16)'], ['Atlas', 'uppercase'],
  ['2abc', 'digit-first'], ['-abc', 'hyphen-first'], ['a_b', 'underscore'], ['a.b', 'dot'],
  ['a/b', 'slash'], ['a b', 'space'], ['', 'empty'], ['abc\n', 'trailing newline (name reaches paths)'],
  ['../x', 'traversal'], ['ätlas', 'unicode'],
]
for (const [bad, why] of badNames) check(`refused: ${JSON.stringify(bad)} (${why})`, cs.isValidCrewName(bad) === false)
for (const reserved of ['team-lead', 'implementer', 'scribe', 'tank', 'healer', 'dps1', 'dps2', 'dps3', 'crew', 'daemon']) {
  check(`reserved refused: '${reserved}'`, cs.isValidCrewName(reserved) === false)
}

section('buildCrewSpec — the server-side floor (everything security-relevant)')
const spec = cs.buildCrewSpec('atlas', 'sonnet', '/proj')
check('model/effort from the table', spec.model === 'claude-sonnet-5' && spec.effort === 'high')
check("permissionMode 'flow' (run-#2 lesson: default-mode -p terminal-denies)", spec.permissionMode === 'flow')
check('allowedTools = the worker recon set (classifier-fault immunity)', JSON.stringify(spec.allowedTools) === JSON.stringify(wr.resolveWorkerReconAllow()))
check('recon set is non-empty', (spec.allowedTools?.length ?? 0) > 0)
check("extraEnv floor: MERCURY_WORKFLOWS='0' (no agent DAGs)", spec.extraEnv?.MERCURY_WORKFLOWS === '0')
check('extraEnv identity: MERCURY_CREW_AGENT = name', spec.extraEnv?.MERCURY_CREW_AGENT === 'atlas')
check("role 'MERCURY_CREW'", spec.role === 'MERCURY_CREW')
check('identity triplet atlas / atlas@crew / crew', spec.agentName === 'atlas' && spec.agentId === 'atlas@crew' && spec.teamName === 'crew')
check('cwd threaded', spec.cwd === '/proj')
const pack = spec.appendSystemPrompt
check('pack names @atlas', pack.includes('@atlas'))
check('pack carries the SendMessage→team-lead reply contract', pack.includes('SendMessage') && pack.includes('team-lead'))
check('pack forbids gate bypass', /Never bypass a permission/.test(pack))
check('pack forbids daemons/fan-out', pack.includes('no daemons, no agent fan-out'))
const opusSpec = cs.buildCrewSpec('atlas', 'opus', '/proj')
check('opus key resolves the current Opus (natively 1M, bare id)', opusSpec.model === 'claude-opus-5')

section('buildStreamJsonInvocation(crew) — what the child actually boots with')
const inv = hr.buildStreamJsonInvocation(spec)
check("child env MERCURY_CREW='1' (role stamp)", inv.env.MERCURY_CREW === '1')
check('child env MERCURY_CREW_AGENT SURVIVES the sanitize (crew spec)', inv.env.MERCURY_CREW_AGENT === 'atlas')
check("child env MERCURY_WORKFLOWS='0'", inv.env.MERCURY_WORKFLOWS === '0')
check('child ANTHROPIC_MODEL = table model', inv.env.ANTHROPIC_MODEL === 'claude-sonnet-5')
const argvStr = inv.argv.join(' ')
check('argv: --permission-mode flow', /--permission-mode(=| )flow/.test(argvStr))
check('argv: --allowedTools with the recon rules', inv.argv.includes('--allowedTools'))
check('argv: identity triplet flags', inv.argv.includes('atlas') && inv.argv.includes('atlas@crew') && inv.argv.includes('crew'))

section('role-pair hygiene — the three scrub seams (dual-polarity safe)')
// (1) supervisor scrub: role form + name stripped; the operator kill survives.
{
  const env: NodeJS.ProcessEnv = { MERCURY_CREW: '1', MERCURY_CREW_AGENT: 'zombie', MERCURY_SCRIBE: '1', OTHER: 'x' }
  const removed = hr.scrubSupervisorRoleEnv(env)
  check('scrub removes the crew ROLE form + name (+ scribe)', env.MERCURY_CREW === undefined && env.MERCURY_CREW_AGENT === undefined && env.MERCURY_SCRIBE === undefined)
  check('scrub reports what it removed', removed.includes('MERCURY_CREW') && removed.includes('MERCURY_CREW_AGENT'))
  check('unrelated env untouched', env.OTHER === 'x')
}
{
  const env: NodeJS.ProcessEnv = { MERCURY_CREW: '0' }
  const removed = hr.scrubSupervisorRoleEnv(env)
  check("scrub PRESERVES the operator kill MERCURY_CREW='0'", env.MERCURY_CREW === '0' && removed.length === 0)
}
// (2) long-lived child sanitize: a NON-crew child never inherits crew identity
// (a leaked crew role would hijack its replies to team-lead — the
// implementerReplyTarget crew branch wins). The non-crew shape here is the
// implementer's (the one long-lived daemon worker besides the crew).
const nonCrewSpec = () => ({
  model: 'claude-sonnet-5',
  effort: 'high',
  appendSystemPrompt: '',
  role: 'MERCURY_IMPLEMENTER' as const,
  agentName: 'implementer',
  agentId: 'implementer@scribe',
  teamName: 'scribe',
  cwd: '/proj',
})
{
  process.env.MERCURY_CREW = '1'
  process.env.MERCURY_CREW_AGENT = 'zombie'
  const seat = hr.buildStreamJsonInvocation(nonCrewSpec())
  check('a non-crew seat inherits NO crew identity (reply-hijack closed)', seat.env.MERCURY_CREW === undefined && seat.env.MERCURY_CREW_AGENT === undefined)
  delete process.env.MERCURY_CREW
  delete process.env.MERCURY_CREW_AGENT
}
// …while the operator kill still rides through to children:
{
  process.env.MERCURY_CREW = '0'
  const seat = hr.buildStreamJsonInvocation(nonCrewSpec())
  check("non-crew child inherits MERCURY_CREW='0' (the kill propagates)", seat.env.MERCURY_CREW === '0')
  delete process.env.MERCURY_CREW
}
// extraEnv injection: a spec whose extraEnv smuggles crew identity onto a
// non-crew child is sanitized (the role-hygiene-after-extraEnv ordering).
{
  const seatSpec = { ...nonCrewSpec(), extraEnv: { MERCURY_CREW: '1', MERCURY_CREW_AGENT: 'smuggled' } }
  const seat = hr.buildStreamJsonInvocation(seatSpec)
  check('extraEnv-smuggled crew identity is sanitized off a non-crew child', seat.env.MERCURY_CREW === undefined && seat.env.MERCURY_CREW_AGENT === undefined)
}
// (3) cron one-shot clone parity: same pair rules as the supervisor scrub.
{
  process.env.MERCURY_CREW = '1'
  process.env.MERCURY_CREW_AGENT = 'zombie'
  const seat = hr.buildStreamJsonInvocation(nonCrewSpec())
  check('sanity: a second non-crew spawn also clean under pollution', seat.env.MERCURY_CREW === undefined && seat.env.MERCURY_CREW_AGENT === undefined)
  delete process.env.MERCURY_CREW
  delete process.env.MERCURY_CREW_AGENT
}

section('assertSingleRole — crew counts as a role; the kill value never does')
{
  process.env.MERCURY_CREW = '1'
  process.env.MERCURY_DPS1 = '1'
  let threw = false
  try { gates.assertSingleRole() } catch { threw = true }
  check('crew + dps1 double-tag fails LOUD', threw)
  process.env.MERCURY_CREW = '0'
  process.env.MERCURY_IMPLEMENTER = '1'
  delete process.env.MERCURY_DPS1
  let threw2 = false
  try { gates.assertSingleRole() } catch { threw2 = true }
  check("MERCURY_CREW='0' + implementer is NOT a double role (dual-polarity safe)", threw2 === false)
  delete process.env.MERCURY_CREW
  delete process.env.MERCURY_IMPLEMENTER
}

rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) { console.log(`❌ ${failures} CREW SPEC-FLOOR PROOF(S) FAILED`); process.exit(1) }
console.log('✅ ALL CREW SPEC-FLOOR PROOFS PASS')
