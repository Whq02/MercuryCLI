#!/usr/bin/env bun
import { getEmptyToolPermissionContext } from '../../src/tools/kit/tool.js'
import type { CustomAgentDefinition } from '../../src/crew/agents/agentDefinition.js'
import { anthropicProviderAdapter } from '../../src/models/roads/anthropic/anthropicAdapter.js'
import { openaiProviderAdapter } from '../../src/models/roads/openai/openaiAdapter.js'
import { zaiProviderAdapter } from '../../src/models/roads/zai/zaiAdapter.js'
import {
  buildCrewmateLaunchPlan,
  type CrewmateLaunchPlanInput,
} from '../../src/crew/crewmates/agentLaunchPlan.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 's1-contracts-'))
const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
enableConfigs()

let failures = 0
let s1Where = ''
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && s1Where ? `${detail ? '; ' : ' — '}${s1Where}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' S1 — contract freeze (adapter surface · launch plan)')
console.log('============================================================')

section('1 · ProviderAdapter — exactly the frozen member set')
{
  s1Where = 'change the adapter object so its members match the frozen list in this test: src/models/roads/anthropic/anthropicAdapter.ts, src/models/roads/openai/openaiAdapter.ts or src/models/roads/zai/zaiAdapter.ts (or update the list here if the surface was widened on purpose)'
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
  s1Where = 'change buildAgentLaunchPlan in src/crew/crewmates/agentLaunchPlan.ts so the plan follows the law this check names'
  const mkDef = (over: Partial<CustomAgentDefinition> = {}): CustomAgentDefinition => ({
    agentType: 'orbit-probe',
    whenToUse: 'orbit s1 freeze probe',
    getSystemPrompt: () => 'probe',
    source: 'projectSettings',
    ...over,
  })
  const base = (over: Partial<CrewmateLaunchPlanInput> = {}): CrewmateLaunchPlanInput => ({
    requestedType: 'orbit-probe',
    activeAgents: [mkDef()],
    toolPermissionContext: getEmptyToolPermissionContext(),
    defaultAgentType: 'orbit-probe',
    engineModel: 'claude-opus-4-8',
    backgroundTasksDisabled: false,
    forceAsync: false,
    ...over,
  })

  const plan = buildCrewmateLaunchPlan(base())
  check('resolves the requested definition (agentType echoes)', plan.agentType === 'orbit-probe')
  check("workerPermissionMode defaults to 'implement'", plan.workerPermissionMode === 'implement')
  check('no isolation by default', plan.isolation === undefined)
  check('sync by default', plan.shouldRunAsync === false)

  let notFoundMsg = ''
  try {
    buildCrewmateLaunchPlan(base({ requestedType: 'orbit-unknown' }))
  } catch (e) {
    notFoundMsg = e instanceof Error ? e.message : String(e)
  }
  check(
    'unknown type throws the exact not-found shape',
    notFoundMsg.startsWith("No crewmate type named 'orbit-unknown'; this session offers: "),
    notFoundMsg,
  )

  const roster = [mkDef({ agentType: 'mercury-scout' })]
  const seamPlan = buildCrewmateLaunchPlan(
    base({
      requestedType: 'mercury-scout',
      activeAgents: roster,
    }),
  )
  check('the plan resolves a registered id as written', seamPlan.agentType === 'mercury-scout')
  let emptyPlan: string | undefined
  try {
    emptyPlan = buildCrewmateLaunchPlan(base({ requestedType: '', activeAgents: roster, defaultAgentType: 'mercury-scout' })).agentType
  } catch (e) {
    emptyPlan = e instanceof Error ? e.message : String(e)
  }
  check('an empty requested type is no type: the default agent type runs', emptyPlan === 'mercury-scout', String(emptyPlan))

  const isoDef = buildCrewmateLaunchPlan(base({ activeAgents: [mkDef({ isolation: 'worktree' })] }))
  check("definition isolation rides ('worktree')", isoDef.isolation === 'worktree')
  const isoParam = buildCrewmateLaunchPlan(
    base({ activeAgents: [mkDef({ isolation: 'worktree' })], isolationParam: 'remote' }),
  )
  check('explicit isolationParam wins over the definition', isoParam.isolation === 'remote')

  check(
    'runInBackground:true ⇒ async',
    buildCrewmateLaunchPlan(base({ runInBackground: true })).shouldRunAsync === true,
  )
  check(
    'definition.background:true ⇒ async',
    buildCrewmateLaunchPlan(base({ activeAgents: [mkDef({ background: true })] })).shouldRunAsync === true,
  )
  check(
    'forceAsync:true ⇒ async',
    buildCrewmateLaunchPlan(base({ forceAsync: true })).shouldRunAsync === true,
  )
  check(
    'backgroundTasksDisabled vetoes every async source',
    buildCrewmateLaunchPlan(
      base({ runInBackground: true, forceAsync: true, backgroundTasksDisabled: true }),
    ).shouldRunAsync === false,
  )

  const modeDef = buildCrewmateLaunchPlan(base({ activeAgents: [mkDef({ permissionMode: 'dontAsk' })] }))
  check("definition permissionMode wins ('dontAsk')", modeDef.workerPermissionMode === 'dontAsk')

  const haikuPlan = buildCrewmateLaunchPlan(base({ activeAgents: [mkDef({ model: 'haiku' })] }))
  check('a haiku definition pin resolves to the haiku row', /haiku/i.test(haikuPlan.model), haikuPlan.model)
  check('the receipt names the resolved Anthropic engine', haikuPlan.modelNote === `engine: Anthropic (${haikuPlan.model}) via the native in-process transport`, haikuPlan.modelNote ?? 'undefined')

  const untyped = buildCrewmateLaunchPlan(base({ requestedType: undefined }))
  check('no requested type resolves the default type', untyped.agentType === 'orbit-probe')
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ALL S1 CONTRACT-FREEZE PROOFS PASS')
else console.log(`${failures} S1 CONTRACT-FREEZE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
