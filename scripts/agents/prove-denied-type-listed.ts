#!/usr/bin/env bun
import '../lib/hermetic.ts'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

let failed = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const { AgentTool } = await import('../../src/tools/AgentTool/AgentTool.tsx')
const { buildAgentLaunchPlan } = await import('../../src/utils/crew/agentLaunchPlan.ts')
const { MERCURY_CREW_AGENT_TYPE } = await import('../../src/tools/AgentTool/constants.ts')
type AgentDefinition = import('../../src/tools/AgentTool/loadAgentsDir.ts').AgentDefinition
type ToolPermissionContext = import('../../src/Tool.ts').ToolPermissionContext

const agents = [
  { agentType: MERCURY_CREW_AGENT_TYPE, whenToUse: 'the general crewmate', source: 'built-in', tools: undefined },
  { agentType: 'auditor', whenToUse: 'reads the ledger', source: 'userSettings', tools: ['Read', 'Grep'] },
  { agentType: 'deployer', whenToUse: 'ships the build', source: 'projectSettings', tools: ['Bash'] },
] as unknown as AgentDefinition[]

const context = (deny: readonly string[], reasons?: Record<string, string>): ToolPermissionContext => ({
  mode: 'default',
  alwaysAllowRules: {},
  alwaysDenyRules: deny.length > 0 ? { userSettings: [...deny] } : {},
  alwaysAskRules: {},
  ...(reasons ? { ruleReasons: { userSettings: reasons } } : {}),
  isBypassPermissionsModeAvailable: false,
}) as unknown as ToolPermissionContext

const promptUnder = (ctx: ToolPermissionContext): Promise<string> =>
  AgentTool.prompt!({ getToolPermissionContext: async () => ctx as never, tools: [], agents })

console.log('── §1 a denied type stays listed, with its refusal ──')
const denied = await promptUnder(context(['Crewmate(deployer)']))
const listingOf = (prompt: string): string[] => prompt.split('\n').slice(0, prompt.split('\n').indexOf('## When delegating is the wrong move')).filter(line => line.startsWith('- '))
const lines = listingOf(denied)
const deployerLine = lines.find(line => line.startsWith('- deployer:'))
check('the denied type is still on the list', deployerLine !== undefined, lines.join(' | '))
check('…its line carries the refusal', deployerLine !== undefined && deployerLine.includes('launching it is denied by the rule Crewmate(deployer) in your user settings'), deployerLine)
check('…after the unchanged listing shape', deployerLine?.startsWith('- deployer: ships the build (Tools: Bash) — ') === true, deployerLine)
check('the other types carry no refusal', lines.filter(l => l !== deployerLine).every(l => !l.includes('denied')))

console.log('── §2 the rule\'s reason rides on the line ──')
const reasoned = await promptUnder(context(['Crewmate(deployer)'], { 'Crewmate(deployer)': 'deploys are the release lead\'s' }))
const reasonedLine = reasoned.split('\n').find(line => line.startsWith('- deployer:'))
check('the reason follows the sentence', reasonedLine?.endsWith("in your user settings: deploys are the release lead's.") === true, reasonedLine)

console.log('── §3 the launch still refuses with the same words ──')
let launchRefusal = ''
try {
  buildAgentLaunchPlan({
    requestedType: 'deployer',
    defaultAgentType: MERCURY_CREW_AGENT_TYPE,
    activeAgents: agents,
    toolPermissionContext: context(['Crewmate(deployer)']),
  } as never)
} catch (error) {
  launchRefusal = (error as Error).message
}
check('a launch of the denied type is refused', launchRefusal.includes('is denied by the rule Crewmate(deployer) in your user settings'), launchRefusal)

console.log('── §4 refusals: the control ──')
const open = await promptUnder(context([]))
const openOnBase = await promptUnder(context(['Bash(rm *)']))
check('with no deny rule on a type the prompt is byte-identical to the open prompt', open === openOnBase)
check('…and no listing line mentions a denial', listingOf(open).every(l => !l.includes(' — ')))
const restricted = await promptUnder(context(['Crewmate(deployer)']))
check('a deny on a whole other tool never marks a type', (await promptUnder(context(['Bash']))) === open)
check('a deny on the Crewmate tool for one type marks exactly that line', listingOf(restricted).filter(l => l.includes(' — launching it is denied')).length === 1)
const allowedTypes = await AgentTool.prompt!({ getToolPermissionContext: async () => context(['Crewmate(deployer)']) as never, tools: [], agents, allowedAgentTypes: ['auditor'] })
check('a Crewmate(x,y) restriction still narrows the list (a denied type outside it stays off)', !allowedTypes.includes('- deployer:') && allowedTypes.includes('- auditor:'))

console.log(failed === 0 ? '\nprove-denied-type-listed: all green' : `\nprove-denied-type-listed: ${failed} FAILURE(S)`)
process.exit(failed === 0 ? 0 : 1)
