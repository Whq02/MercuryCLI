#!/usr/bin/env bun
import { getEmptyToolPermissionContext } from '../../src/Tool.js'
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
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 's1-contracts-'))
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()

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

section('1 · RouterProviderAdapter — exactly the frozen member set')
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

section('2 · buildAgentLaunchPlan — decision laws')
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

  check('decodeAgentType reads a registered id as written', decodeAgentType('mercury-scout') === 'mercury-scout')
  check('decodeAgentType passes unknown ids through', decodeAgentType('orbit-probe') === 'orbit-probe')
  check('decodeAgentType(undefined) is no type', decodeAgentType(undefined) === undefined)
  const seamPlan = buildAgentLaunchPlan(
    base({
      requestedType: 'mercury-scout',
      activeAgents: [mkDef({ agentType: 'mercury-scout' })],
    }),
  )
  check("the plan resolves a registered id through the seam", seamPlan.agentType === 'mercury-scout')

  const isoDef = buildAgentLaunchPlan(base({ activeAgents: [mkDef({ isolation: 'worktree' })] }))
  check("definition isolation rides ('worktree')", isoDef.isolation === 'worktree')
  const isoParam = buildAgentLaunchPlan(
    base({ activeAgents: [mkDef({ isolation: 'worktree' })], isolationParam: 'remote' }),
  )
  check('explicit isolationParam wins over the definition', isoParam.isolation === 'remote')

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

  const modeDef = buildAgentLaunchPlan(base({ activeAgents: [mkDef({ permissionMode: 'strategy' })] }))
  check("definition permissionMode wins ('strategy')", modeDef.workerPermissionMode === 'strategy')

  const haikuPlan = buildAgentLaunchPlan(base({ activeAgents: [mkDef({ model: 'haiku' })] }))
  check('haiku definition pin is floored (result is not Haiku-tier)', !isHaikuTier(haikuPlan.model), haikuPlan.model)
  check('flooredFrom records the pre-floor resolution', typeof haikuPlan.flooredFrom === 'string' && haikuPlan.flooredFrom.length > 0, haikuPlan.flooredFrom ?? '')
  check(
    "modelNote surfaces the never-Haiku floor (never silent)",
    (haikuPlan.modelNote ?? '').includes("never-Haiku floor"),
    haikuPlan.modelNote ?? 'undefined',
  )

  const forkPlan = buildAgentLaunchPlan(base({ requestedType: undefined, forkGateOn: true }))
  check('fork path resolves the injected fork definition', forkPlan.isForkPath && forkPlan.agentType === 'orbit-fork')
}

section('3 · deriveRunnerAgentDefinition — teammate product laws')
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
