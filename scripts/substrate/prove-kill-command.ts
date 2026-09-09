#!/usr/bin/env bun
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ALL_AGENTS,
  isCapabilityKilled,
  killCapability,
  restoreCapability,
  listCapabilityKills,
} from '../../src/utils/permissions/capabilityGate.js'
import { parseKillToken, scopeLabel } from '../../src/commands/kill/shared.js'
import { kill, unkill } from '../../src/commands/kill/index.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' /kill + /unkill — runtime capability kill-switch')
console.log('============================================================')

section('parseKillToken grammar (mirrors MERCURY_KILL / seedFromEnv)')
check('bare `Bash` ⇒ ALL_AGENTS scope', parseKillToken('Bash').agentType === ALL_AGENTS && parseKillToken('Bash').toolName === 'Bash')
const sc = parseKillToken('scout:Bash')
check('`scout:Bash` ⇒ {agent:scout, tool:Bash}', sc.agentType === 'scout' && sc.toolName === 'Bash')
check('`:Bash` (empty agent) ⇒ ALL_AGENTS', parseKillToken(':Bash').agentType === ALL_AGENTS)
check('scopeLabel(*) = "all agents"', scopeLabel(ALL_AGENTS) === 'all agents')

section('the ALL_AGENTS correctness: a bare kill MUST enforce for every agent')
const T = '__proof_kill_all__'
killCapability(ALL_AGENTS, T)
check('killCapability(*, T) ⇒ isCapabilityKilled(T, "scout") TRUE (the * key)', isCapabilityKilled(T, 'scout') === true)
check('… also enforces for a different agent', isCapabilityKilled(T, 'someother') === true)
check('listCapabilityKills shows T under the * key', (listCapabilityKills()[ALL_AGENTS] || []).includes(T))
restoreCapability(ALL_AGENTS, T)
check('restoreCapability(*, T) ⇒ no longer killed', isCapabilityKilled(T, 'scout') === false)

section('end-to-end: the actual /kill + /unkill command handlers mutate + enforce')
const km = (await import('../../src/commands/kill/kill.js')) as { call: (a: string, c: unknown) => Promise<{ type: string; value: string }> }
const um = (await import('../../src/commands/kill/unkill.js')) as { call: (a: string, c: unknown) => Promise<{ type: string; value: string }> }
const r1 = await km.call('__proof_cmd__', {})
check('/kill <tool> returns a text result', r1.type === 'text' && /Killed/.test(r1.value))
check('/kill <tool> actually kills it at the gate (any agent)', isCapabilityKilled('__proof_cmd__', 'whoever') === true)
const r2 = await um.call('__proof_cmd__', {})
check('/unkill <tool> returns text + restores', r2.type === 'text' && isCapabilityKilled('__proof_cmd__', 'whoever') === false)
const rList = await km.call('', {})
check('/kill (no arg) lists current kills (no mutation)', rList.type === 'text' && /killed this session/i.test(rList.value))
await km.call('scout:__proof_scoped__', {})
check('/kill scout:tool scopes to that agent only', isCapabilityKilled('__proof_scoped__', 'scout') === true && isCapabilityKilled('__proof_scoped__', 'other') === false)
await um.call('scout:__proof_scoped__', {})

section('stamp-gated + registered (OFF byte-identical)')
check('kill descriptor is type:local, stamp-gated', kill.type === 'local' && kill.name === 'kill' && kill.isEnabled?.() === true)
check('unkill descriptor is type:local, stamp-gated', unkill.type === 'local' && unkill.name === 'unkill' && unkill.isEnabled?.() === true)
check('index.ts is enabled unconditionally ()', /isEnabled:\s*\(\)\s*=>\s*true/.test(src('commands', 'kill', 'index.ts')))
const cmds = src('commands.ts')
check('registered in commands.ts (import + array)', /import \{ kill, unkill \}/.test(cmds) && /\bkill,\s*\n\s*unkill,/.test(cmds))
check('ALL_AGENTS is exported from capabilityGate (single source of truth)', /export const ALL_AGENTS/.test(src('utils', 'permissions', 'capabilityGate.ts')))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL KILL-COMMAND PROOFS PASS')
else console.log(`❌ ${failures} KILL-COMMAND PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
