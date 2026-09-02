#!/usr/bin/env bun
// ============================================================================
//  scripts/agent-dispatch/prove-s1-contracts.ts
//  PROOF: the seams extends hold
//  their landed shapes, so every later evolution is a DELIBERATE, proof-updated
//  act rather than drift:
//
//    1. The RouterProviderAdapter surface is EXACTLY the landed five members
//       on all three adapters (id/status/listModels/resolveModel/
//       buildLaunchPatch) — S2 widening this interface must update this freeze
//       in the same commit.
//    2. buildAgentLaunchPlan holds its decision laws: definition resolution +
//       exact not-found message, legacy alias decode (the ONE truth,
//       roleResolver.decodeAgentType over LEGACY_SUBAGENT_ALIASES), the
//       isolation-param-wins rule, the async combination law, the
//       workerPermissionMode default, and the never-Haiku floor note.
//    3. deriveRunnerAgentDefinition holds: canonical agentType precedence,
//       TEAM_ESSENTIAL_TOOLS injection, permissionMode 'default', model pin
//       propagation.
//
//  (The provider stubs' behavior freeze — unavailable/empty/null/throws +
//  registry no-fallthrough — already lives in scripts/router/
//  prove-providers.ts; this file freezes the seams THAT proof doesn't own.)
//
//  Run:  ~/.bun/bin/bun run scripts/agent-dispatch/prove-s1-contracts.ts
// ============================================================================
import { getEmptyToolPermissionContext } from '../../src/Tool.js'
import { LEGACY_SUBAGENT_ALIASES } from '../../src/tools/AgentTool/builtInAgents.js'
import type { AgentDefinition, CustomAgentDefinition } from '../../src/tools/AgentTool/loadAgentsDir.js'
import { isHaikuTier } from '../../src/utils/model/modelFloor.js'
import { anthropicProviderAdapter } from '../../src/utils/router/providers/anthropic.js'
import { openaiProviderAdapter } from '../../src/utils/router/providers/openai.js'
import { zaiProviderAdapter } from '../../src/utils/router/providers/zai.js'
import {
  buildAgentLaunchPlan,
  deriveRunnerAgentDefinition,
  TEAM_ESSENTIAL_TOOLS,
  type AgentLaunchPlanInput,
} from '../../src/utils/swarm/agentLaunchPlan.js'
import { decodeAgentType } from '../../src/utils/swarm/roleResolver.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' S1 — contract freeze (adapter surface · launch plan)')
console.log('============================================================')

//
section('1 · RouterProviderAdapter — exactly the frozen member set')
//
// S1 froze the landed five (id/status/listModels/resolveModel/buildLaunchPatch);
// S2 widened the surface with `transport` +
// `describe` — the typed description layer. Any FURTHER widening updates this
// freeze in the same commit or fails here.
{
  const FROZEN_MEMBERS = [
    'id',
    'transport',
    'status',
    'describe',
    'listModels',
    'resolveModel',
    'buildLaunchPatch',
  ].sort()
  for (const adapter of [anthropicProviderAdapter, openaiProviderAdapter, zaiProviderAdapter]) {
    const keys = Object.keys(adapter).sort()
    check(
      `${adapter.id}: adapter members are exactly the frozen set (S2 widened: +transport +describe)`,
      JSON.stringify(keys) === JSON.stringify(FROZEN_MEMBERS),
      keys.join(','),
    )
  }
}

//
section('2 · buildAgentLaunchPlan — decision laws')
//
{
  const mkDef = (over: Partial<CustomAgentDefinition> = {}): CustomAgentDefinition => ({
    agentType: 'orbit-probe',
    whenToUse: 'orbit s1 freeze probe',
    getSystemPrompt: () => 'probe',
    source: 'projectSettings',
    ...over,
  })
  const forkAgent = mkDef({ agentType: 'orbit-fork' })
  const base = (over: Partial<AgentLaunchPlanInput> = {}): AgentLaunchPlanInput => ({
    requestedType: 'orbit-probe',
    activeAgents: [mkDef()],
    toolPermissionContext: getEmptyToolPermissionContext(),
    forkGateOn: false,
    forkAgent,
    defaultAgentType: 'orbit-probe',
    mainLoopModel: 'claude-opus-4-8',
    backgroundTasksDisabled: false,
    forceAsync: false,
    ...over,
  })

  const plan = buildAgentLaunchPlan(base())
  check('resolves the requested definition (agentType echoes)', plan.agentType === 'orbit-probe')
  check('not the fork path when a type is requested', plan.isForkPath === false)
  check("workerPermissionMode defaults to 'implement'", plan.workerPermissionMode === 'implement')
  check('no isolation by default', plan.isolation === undefined)
  check('sync by default', plan.shouldRunAsync === false)

  // Exact not-found message (model-visible tool surface — frozen bytes).
  let notFoundMsg = ''
  try {
    buildAgentLaunchPlan(base({ requestedType: 'orbit-unknown' }))
  } catch (e) {
    notFoundMsg = e instanceof Error ? e.message : String(e)
  }
  check(
    'unknown type throws the exact not-found shape',
    notFoundMsg.startsWith("Agent type 'orbit-unknown' not found. Available agents: "),
    notFoundMsg,
  )

  // Legacy alias decode is the ONE truth (roleResolver over LEGACY_SUBAGENT_ALIASES).
  const aliasEntries = Object.entries(LEGACY_SUBAGENT_ALIASES)
  check('legacy alias table is non-empty (Explore/Plan/claude era)', aliasEntries.length >= 3)
  for (const [legacy, canonical] of aliasEntries) {
    check(`decodeAgentType('${legacy}') → '${canonical}'`, decodeAgentType(legacy) === canonical)
  }
  check('decodeAgentType passes unknown ids through', decodeAgentType('orbit-probe') === 'orbit-probe')
  const [legacyId, canonicalId] = aliasEntries[0]!
  const aliasPlan = buildAgentLaunchPlan(
    base({
      requestedType: legacyId,
      activeAgents: [mkDef({ agentType: canonicalId })],
    }),
  )
  check(
    `plan decodes legacy '${legacyId}' to canonical '${canonicalId}'`,
    aliasPlan.agentType === canonicalId,
  )

  // Isolation: the explicit param wins over the definition.
  const isoDef = buildAgentLaunchPlan(base({ activeAgents: [mkDef({ isolation: 'worktree' })] }))
  check("definition isolation rides ('worktree')", isoDef.isolation === 'worktree')
  const isoParam = buildAgentLaunchPlan(
    base({ activeAgents: [mkDef({ isolation: 'worktree' })], isolationParam: 'remote' }),
  )
  check('explicit isolationParam wins over the definition', isoParam.isolation === 'remote')

  // Async combination law: (runInBackground | definition.background | forceAsync) & !disabled.
  check(
    'runInBackground:true ⇒ async',
    buildAgentLaunchPlan(base({ runInBackground: true })).shouldRunAsync === true,
  )
  check(
    'definition.background:true ⇒ async',
    buildAgentLaunchPlan(base({ activeAgents: [mkDef({ background: true })] })).shouldRunAsync === true,
  )
  check(
    'forceAsync:true ⇒ async',
    buildAgentLaunchPlan(base({ forceAsync: true })).shouldRunAsync === true,
  )
  check(
    'backgroundTasksDisabled vetoes every async source',
    buildAgentLaunchPlan(
      base({ runInBackground: true, forceAsync: true, backgroundTasksDisabled: true }),
    ).shouldRunAsync === false,
  )

  // workerPermissionMode: the definition's own mode wins over the default.
  const modeDef = buildAgentLaunchPlan(base({ activeAgents: [mkDef({ permissionMode: 'strategy' })] }))
  check("definition permissionMode wins ('strategy')", modeDef.workerPermissionMode === 'strategy')

  // The never-Haiku floor: a legacy haiku pin remaps + the note names the floor.
  const haikuPlan = buildAgentLaunchPlan(base({ activeAgents: [mkDef({ model: 'haiku' })] }))
  check('haiku definition pin is floored (result is not Haiku-tier)', !isHaikuTier(haikuPlan.model), haikuPlan.model)
  check('flooredFrom records the pre-floor resolution', typeof haikuPlan.flooredFrom === 'string' && haikuPlan.flooredFrom.length > 0, haikuPlan.flooredFrom ?? '')
  check(
    "modelNote surfaces the never-Haiku floor (never silent)",
    (haikuPlan.modelNote ?? '').includes("never-Haiku floor"),
    haikuPlan.modelNote ?? 'undefined',
  )

  // Fork path: no requested type + stamp gate on ⇒ the injected fork definition.
  const forkPlan = buildAgentLaunchPlan(base({ requestedType: undefined, forkGateOn: true }))
  check('fork path resolves the injected fork definition', forkPlan.isForkPath && forkPlan.agentType === 'orbit-fork')
}

//
section('3 · deriveRunnerAgentDefinition — teammate product laws')
//
{
  const baseDef: AgentDefinition = {
    agentType: 'orbit-role-def',
    whenToUse: 'probe',
    getSystemPrompt: () => 'probe',
    source: 'projectSettings',
    tools: ['Read'],
    model: 'claude-sonnet-5',
  }
  const derived = deriveRunnerAgentDefinition({
    agentDefinition: baseDef,
    displayName: 'Probe',
    systemPrompt: 'composed prompt',
  })
  check('agentType prefers the definition over displayName', derived.agentType === 'orbit-role-def')
  check(
    'explicit tools gain every TEAM_ESSENTIAL_TOOL',
    TEAM_ESSENTIAL_TOOLS.every(t => derived.tools!.includes(t)) && derived.tools!.includes('Read'),
    derived.tools!.join(','),
  )
  check("permissionMode is 'default' (runner overlays live mode per turn)", derived.permissionMode === 'default')
  check('model pin propagates', derived.model === 'claude-sonnet-5')

  const bare = deriveRunnerAgentDefinition({ displayName: 'Bare', systemPrompt: 'p' })
  check('no definition ⇒ displayName is identity of last resort', bare.agentType === 'Bare')
  check("no explicit tools ⇒ ['*']", JSON.stringify(bare.tools) === JSON.stringify(['*']))
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ALL S1 CONTRACT-FREEZE PROOFS PASS')
else console.log(`${failures} S1 CONTRACT-FREEZE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
