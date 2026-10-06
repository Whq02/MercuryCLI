#!/usr/bin/env bun
import { getEmptyToolPermissionContext } from '../../src/Tool.js'
import type { CustomAgentDefinition } from '../../src/tools/AgentTool/loadAgentsDir.js'
import { anthropicProviderAdapter } from '../../src/utils/router/providers/anthropic.js'
import { openaiProviderAdapter } from '../../src/utils/router/providers/openai.js'
import { zaiProviderAdapter } from '../../src/utils/router/providers/zai.js'
import {
  buildAgentLaunchPlan,
  type AgentLaunchPlanInput,
} from '../../src/utils/crew/agentLaunchPlan.js'
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
    engineModel: 'claude-opus-4-8',
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

  const roster = [mkDef({ agentType: 'mercury-scout' })]
  const seamPlan = buildAgentLaunchPlan(
    base({
      requestedType: 'mercury-scout',
      activeAgents: roster,
    }),
  )
  check('the plan resolves a registered id as written', seamPlan.agentType === 'mercury-scout')
  let emptyPlan: string | undefined
  try {
    emptyPlan = buildAgentLaunchPlan(base({ requestedType: '', activeAgents: roster, forkGateOn: false, defaultAgentType: 'mercury-scout' })).agentType
  } catch (e) {
    emptyPlan = e instanceof Error ? e.message : String(e)
  }
  check('an empty requested type is no type: the default agent type runs', emptyPlan === 'mercury-scout', String(emptyPlan))

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

  const modeDef = buildAgentLaunchPlan(base({ activeAgents: [mkDef({ permissionMode: 'dontAsk' })] }))
  check("definition permissionMode wins ('dontAsk')", modeDef.workerPermissionMode === 'dontAsk')

  const haikuPlan = buildAgentLaunchPlan(base({ activeAgents: [mkDef({ model: 'haiku' })] }))
  check('a haiku definition pin resolves to the haiku row', /haiku/i.test(haikuPlan.model), haikuPlan.model)
  check('no note rides a plain resolution', haikuPlan.modelNote === undefined, haikuPlan.modelNote ?? 'undefined')

  const forkPlan = buildAgentLaunchPlan(base({ requestedType: undefined, forkGateOn: true }))
  check('fork path resolves the injected fork definition', forkPlan.isForkPath && forkPlan.agentType === 'orbit-fork')
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ALL S1 CONTRACT-FREEZE PROOFS PASS')
else console.log(`${failures} S1 CONTRACT-FREEZE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
