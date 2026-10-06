#!/usr/bin/env bun
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')
const src = (...p: string[]) => readFileSync(join(ROOT, 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' Crewmate parity — one resolver, every backend')
console.log('============================================================')

delete process.env.MERCURY_EFFORT_LEVEL
delete process.env.MERCURY_WORKFLOW_ROUTING

const resolver = await import('../../src/utils/crew/roleResolver.js')
const { getBuiltInAgents } = await import('../../src/tools/AgentTool/builtInAgents.js')
const { ONE_SHOT_BUILTIN_AGENT_TYPES } = await import('../../src/tools/AgentTool/constants.js')

const agents = getBuiltInAgents()
const customDef = {
  agentType: 'repo-auditor',
  whenToUse: 'Audit the repo.',
  tools: ['Read', 'Grep'],
  model: 'sonnet',
  source: 'projectSettings',
  getSystemPrompt: () => 'You audit repositories with evidence.',
} as never

const baseResolve = {
  crewmateName: 'scout-1',
  agents: [...agents, customDef] as never,
  prompt: 'Map the auth subsystem.\nSecond line.',
  description: 'auth recon',
}

section('§1 — one resolver for built-in + custom + legacy ids')
{
  const scout = resolver.resolveCrewmateRole({ ...baseResolve, requestedAgentType: 'mercury-scout' })
  check('built-in resolves: definition found', scout.definition?.agentType === 'mercury-scout')
  check('built-in role prompt composes WITHOUT live context (static builder)', (resolver.getRoleSystemPrompt(scout.definition!) ?? '').includes('scout'))
  check('built-in tool contract carried (the scout bars write tools)', Array.isArray(scout.disallowedTools) && scout.disallowedTools!.includes('Edit'))
  check('built-in model rule carried', typeof scout.model === 'string' && scout.model !== 'haiku')

  const custom = resolver.resolveCrewmateRole({ ...baseResolve, requestedAgentType: 'repo-auditor' })
  check('custom resolves through the SAME path', custom.definition === customDef && custom.agentType === 'repo-auditor')
  check('custom role prompt composes', resolver.getRoleSystemPrompt(custom.definition!) === 'You audit repositories with evidence.')

  const unknown = resolver.resolveCrewmateRole({ ...baseResolve, requestedAgentType: 'Explore' })
  check('an id no definition carries resolves to itself with no definition (no alias table)', unknown.agentType === 'Explore' && unknown.definition === undefined)
  check('every one-shot built-in id is a registered built-in', [...ONE_SHOT_BUILTIN_AGENT_TYPES].every(id => agents.some(a => a.agentType === id)), [...ONE_SHOT_BUILTIN_AGENT_TYPES].join(','))

  const rolePacket = scout.rolePacket
  check('role packet derives mission from description', rolePacket.mission === 'auth recon')
  check('role packet hands off to the synthesis owner', rolePacket.handoffTo === 'crew-lead')
  check('behavior doctrine rides every resolution', scout.behavior.productName === 'Mercury')
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL CREWMATE-PARITY PROOFS PASS')
else {
  console.log(`❌ ${failures} CREWMATE-PARITY PROOF(S) FAILED`)
  process.exit(1)
}
