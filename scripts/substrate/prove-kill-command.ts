#!/usr/bin/env bun
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import {
  ALL_AGENTS,
  isCapabilityKilled,
  killCapability,
  restoreCapability,
  listCapabilityKills,
} from '../../src/permissions/rules/capabilityGate.js'
import { parseKillToken, scopeLabel } from '../../src/commands/kill/shared.js'
import { kill, unkill } from '../../src/commands/kill/index.js'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  const shown = !cond && hint ? (detail ? `${detail} — ${hint}` : hint) : detail
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' /kill + /unkill — runtime capability kill-switch')
console.log('============================================================')

section('parseKillToken grammar (mirrors MERCURY_KILL / seedFromEnv)')
check('bare `Bash` ⇒ ALL_AGENTS scope', parseKillToken('Bash').agentType === ALL_AGENTS && parseKillToken('Bash').toolName === 'Bash', '', 'fix parseKillToken in src/commands/kill/shared.ts so a bare tool name takes the ALL_AGENTS scope')
const sc = parseKillToken('scout:Bash')
check('`scout:Bash` ⇒ {agent:scout, tool:Bash}', sc.agentType === 'scout' && sc.toolName === 'Bash', '', 'fix parseKillToken in src/commands/kill/shared.ts to split agent:tool')
check('`:Bash` (empty agent) ⇒ ALL_AGENTS', parseKillToken(':Bash').agentType === ALL_AGENTS, '', 'fix parseKillToken in src/commands/kill/shared.ts so an empty agent means ALL_AGENTS')
check('scopeLabel(*) = "all agents"', scopeLabel(ALL_AGENTS) === 'all agents', '', 'fix scopeLabel in src/commands/kill/shared.ts')

section('the ALL_AGENTS correctness: a bare kill MUST enforce for every agent')
const T = '__proof_kill_all__'
killCapability(ALL_AGENTS, T)
check('killCapability(*, T) ⇒ isCapabilityKilled(T, "scout") TRUE (the * key)', isCapabilityKilled(T, 'scout') === true, '', 'fix killCapability and isCapabilityKilled in src/permissions/rules/capabilityGate.ts so the ALL_AGENTS key applies to every agent')
check('… also enforces for a different agent', isCapabilityKilled(T, 'someother') === true, '', 'fix isCapabilityKilled in src/permissions/rules/capabilityGate.ts to consult the ALL_AGENTS key')
check('listCapabilityKills shows T under the * key', (listCapabilityKills()[ALL_AGENTS] || []).includes(T), '', 'fix listCapabilityKills in src/permissions/rules/capabilityGate.ts')
restoreCapability(ALL_AGENTS, T)
check('restoreCapability(*, T) ⇒ no longer killed', isCapabilityKilled(T, 'scout') === false, '', 'fix restoreCapability in src/permissions/rules/capabilityGate.ts')

section('end-to-end: the actual /kill + /unkill command handlers mutate + enforce')
const km = (await import('../../src/commands/kill/kill.js')) as { call: (a: string, c: unknown) => Promise<{ type: string; value: string }> }
const um = (await import('../../src/commands/kill/unkill.js')) as { call: (a: string, c: unknown) => Promise<{ type: string; value: string }> }
const r1 = await km.call('__proof_cmd__', {})
check('/kill <tool> returns a text result', r1.type === 'text' && /Killed/.test(r1.value), '', 'fix the call handler in src/commands/kill/kill.ts')
check('/kill <tool> actually kills it at the gate (any agent)', isCapabilityKilled('__proof_cmd__', 'whoever') === true, '', 'the call handler in src/commands/kill/kill.ts must call killCapability with the ALL_AGENTS scope')
const r2 = await um.call('__proof_cmd__', {})
check('/unkill <tool> returns text + restores', r2.type === 'text' && isCapabilityKilled('__proof_cmd__', 'whoever') === false, '', 'fix the call handler in src/commands/kill/unkill.ts')
const rList = await km.call('', {})
check('/kill (no arg) lists current kills (no mutation)', rList.type === 'text' && /killed this session/i.test(rList.value), '', 'the call handler in src/commands/kill/kill.ts must list current kills when given no argument')
await km.call('scout:__proof_scoped__', {})
check('/kill scout:tool scopes to that agent only', isCapabilityKilled('__proof_scoped__', 'scout') === true && isCapabilityKilled('__proof_scoped__', 'other') === false, '', 'the call handler in src/commands/kill/kill.ts must pass the agent from parseKillToken to killCapability')
await um.call('scout:__proof_scoped__', {})

section('stamp-gated + registered (OFF byte-identical)')
check('kill descriptor is type:local, stamp-gated', kill.type === 'local' && kill.name === 'kill' && kill.isEnabled?.() === true, '', 'fix the kill command descriptor in src/commands/kill/index.ts')
check('unkill descriptor is type:local, stamp-gated', unkill.type === 'local' && unkill.name === 'unkill' && unkill.isEnabled?.() === true, '', 'fix the unkill command descriptor in src/commands/kill/index.ts')

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL KILL-COMMAND PROOFS PASS')
else console.log(`❌ ${failures} KILL-COMMAND PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
