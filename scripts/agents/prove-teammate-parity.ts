#!/usr/bin/env bun
// ============================================================================
//  scripts/agents/prove-teammate-parity.ts — backend-neutral Mercury teammates
//
//
//    §1 ONE resolver: built-in + custom roles resolve identically; legacy
//       aliases decode; role prompts normalize across definition kinds
//    §2 both preparation paths consume the SAME resolver product (in-process
//       spawn, both pane spawns, the pane-child boot, the runner)
//    §3 canonical role identity: the display name never substitutes for
//       agentType; the isCustomAgent-only filter is absent
//    §7 one shared doctrine: role discipline + the handoff packet
//
//  Run: ~/.bun/bin/bun run scripts/agents/prove-teammate-parity.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test' // the effort default chain reads getGlobalConfig
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
console.log(' Teammate parity — one resolver, every backend')
console.log('============================================================')

delete process.env.MERCURY_EFFORT_LEVEL
delete process.env.MERCURY_WORKFLOW_ROUTING

const resolver = await import('../../src/utils/swarm/roleResolver.js')
const { getBuiltInAgents } = await import('../../src/tools/AgentTool/builtInAgents.js')

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
  teammateName: 'scout-1',
  agents: [...agents, customDef] as never,
  prompt: 'Map the auth subsystem.\nSecond line.',
  description: 'auth recon',
}

section('§1 — one resolver for built-in + custom + legacy ids')
{
  const scout = resolver.resolveTeammateRole({ ...baseResolve, requestedAgentType: 'mercury-scout' })
  check('built-in resolves: definition found', scout.definition?.agentType === 'mercury-scout')
  check('built-in role prompt composes WITHOUT live context (static builder)', (resolver.getRoleSystemPrompt(scout.definition!) ?? '').includes('scout'))
  check('built-in tool contract carried (the scout bars write tools)', Array.isArray(scout.disallowedTools) && scout.disallowedTools!.includes('Edit'))
  check('built-in model rule carried', typeof scout.model === 'string' && scout.model !== 'haiku')

  const custom = resolver.resolveTeammateRole({ ...baseResolve, requestedAgentType: 'repo-auditor' })
  check('custom resolves through the SAME path', custom.definition === customDef && custom.agentType === 'repo-auditor')
  check('custom role prompt composes', resolver.getRoleSystemPrompt(custom.definition!) === 'You audit repositories with evidence.')

  const legacy = resolver.resolveTeammateRole({ ...baseResolve, requestedAgentType: 'Explore' })
  check('legacy alias decodes to the canonical Mercury id', legacy.agentType === 'mercury-scout' && legacy.definition?.agentType === 'mercury-scout')

  const rolePacket = scout.rolePacket
  check('role packet derives mission from description', rolePacket.mission === 'auth recon')
  check('role packet hands off to the synthesis owner', rolePacket.handoffTo === 'team-lead')
  check('behavior doctrine rides every resolution', scout.behavior.productName === 'Mercury')
}

section('§2 — every preparation path consumes the resolver')
{
  const spawn = src('tools', 'shared', 'spawnMultiAgent.ts')
  const resolveCalls = spawn.match(/resolveTeammateRole\(\{/g) ?? []
  check('all three spawn handlers resolve through the shared resolver', resolveCalls.length === 3, `${resolveCalls.length} call sites`)
  check('the isCustomAgent-only filter is GONE', !spawn.includes('isCustomAgent'))
  const boot = src('main.tsx')
  check('the pane-child boot resolves through the shared resolver', boot.includes('findRoleDefinition(agentTypeOpt') && boot.includes('getRoleSystemPrompt(roleDefinition)'))
  check('the built-in-skipped-at-boot gap is gone', !boot.includes('skipping custom prompt (not supported)'))
  const runner = src('utils', 'swarm', 'inProcessRunner.ts')
  check('the runner composes the role prompt via the resolver helper', runner.includes('getRoleSystemPrompt(agentDefinition, {'))
  check('the runner composes charter + role packet after the role contract', runner.includes('formatCharterForContext(role.charter)') && runner.includes('formatRolePacketForContext(role.rolePacket)'))
}

section('§3 — canonical role identity')
{
  const launchPlan = src('utils', 'swarm', 'agentLaunchPlan.ts')
  check('runner identity: canonical agentType, display name only as last resort', launchPlan.includes('i.role?.agentType ?? i.agentDefinition?.agentType ?? i.displayName'))
  check('the runner consumes the shared definition product', src('utils', 'swarm', 'inProcessRunner.ts').includes('deriveRunnerAgentDefinition({'))
  const spawn = src('tools', 'shared', 'spawnMultiAgent.ts')
  check('pane children receive the CANONICAL --agent-type', spawn.includes('canonicalAgentType ? `--agent-type ${quote([canonicalAgentType])}`'))
}

section('§7 — one shared doctrine: role discipline + the handoff packet')
{
  const { buildTeammateAddendum } = await import('../../src/utils/swarm/teammatePromptAddendum.js')
  const addendum = buildTeammateAddendum()
  for (const line of [
    'Outcome: what changed or what was learned',
    'Owned surface: files, symbols, or subsystem',
    'Evidence: checks and concrete results',
    'Decisions: choices the lead must preserve',
    'Blockers: only if real, with the clearing action',
    'Next: the single best follow-up',
  ]) {
    check(`handoff packet carries "${line.split(':')[0]}"`, addendum.includes(line))
  }
  check('lead owns synthesis (conclusions + evidence, never transcripts)', addendum.includes('The LEAD owns synthesis'))
  check('role specialization stays real (scout/architect/implementer/verifier)', addendum.includes('a scout maps evidence'))
  check('loyalty defined as outcome-faithful candor', addendum.includes("faithful to the operator's intended OUTCOME"))
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL TEAMMATE-PARITY PROOFS PASS')
else {
  console.log(`❌ ${failures} TEAMMATE-PARITY PROOF(S) FAILED`)
  process.exit(1)
}
