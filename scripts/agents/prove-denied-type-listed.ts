#!/usr/bin/env bun
import '../lib/hermetic.ts'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

let failed = 0
function check(label: string, ok: boolean, detail = '', hint = ''): void {
  if (!ok) failed++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!ok && hint ? ` — ${hint}` : ''}`)
}

const { AgentTool } = await import('../../src/tools/crewmate/CrewmateTool.tsx')
const { setSessionTrustAccepted } = await import('../../src/boot/process-state/processState.ts')
setSessionTrustAccepted(true)
const { buildAgentLaunchPlan } = await import('../../src/crew/crewmates/agentLaunchPlan.ts')
const { MERCURY_CREW_AGENT_TYPE } = await import('../../src/tools/kit/names/agent.ts')
type AgentDefinition = import('../../src/crew/agents/agentDefinition.ts').AgentDefinition
type ToolPermissionContext = import('../../src/tools/kit/tool.ts').ToolPermissionContext

const agents = [
  { agentType: MERCURY_CREW_AGENT_TYPE, whenToUse: 'the general crewmate', source: 'built-in', tools: undefined },
  { agentType: 'auditor', whenToUse: 'reads the ledger', source: 'userSettings', tools: ['Read', 'Grep'] },
  { agentType: 'deployer', whenToUse: 'ships the build', source: 'projectSettings', tools: ['Bash'] },
] as unknown as AgentDefinition[]

const context = (deny: readonly string[], reasons?: Record<string, string>, source: 'userSettings' | 'projectSettings' = 'userSettings'): ToolPermissionContext => ({
  mode: 'default',
  alwaysAllowRules: {},
  alwaysDenyRules: deny.length > 0 ? { [source]: [...deny] } : {},
  alwaysAskRules: {},
  ...(reasons ? { ruleReasons: { [source]: reasons } } : {}),
  isBypassPermissionsModeAvailable: false,
}) as unknown as ToolPermissionContext

const promptUnder = (ctx: ToolPermissionContext): Promise<string> =>
  AgentTool.prompt!({ getToolPermissionContext: async () => ctx as never, tools: [], agents })

console.log('── §1 a denied type stays listed, with its refusal (user rule vs project rule) ──')
const denied = await promptUnder(context(['Crewmate(deployer)']))
const listingOf = (prompt: string): string[] => prompt.split('\n').slice(0, prompt.split('\n').indexOf('## When delegating is the wrong move')).filter(line => line.startsWith('- '))
const lines = listingOf(denied)
const deployerLine = lines.find(line => line.startsWith('- deployer:'))
check('the denied type is still on the list', deployerLine !== undefined, lines.join(' | '), 'the prompt method of AgentTool in src/tools/crewmate/CrewmateTool.tsx must keep a denied type in the listing and pass its refusal to getPrompt (src/tools/crewmate/prompt.ts) instead of filtering it out')
check('…its line carries the refusal', deployerLine !== undefined && deployerLine.includes('launching it is denied by the rule Crewmate(deployer) in your user settings'), deployerLine, 'the refusal is built in the prompt method of AgentTool in src/tools/crewmate/CrewmateTool.tsx with ruleSentence (src/permissions/rules/ruleReason.ts) and appended by formatAgentLine in src/tools/crewmate/prompt.ts')
check('…after the unchanged listing shape', deployerLine?.startsWith('- deployer: ships the build (Tools: Bash) — ') === true, deployerLine, 'formatAgentLine in src/tools/crewmate/prompt.ts must keep the line shape and put the refusal after it')
check('the other types carry no refusal', lines.filter(l => l !== deployerLine).every(l => !l.includes('denied')), '', 'the prompt method of AgentTool in src/tools/crewmate/CrewmateTool.tsx must set a refusal only for the type getDenyRuleForAgent matches')
const projectDenied = await promptUnder(context(['Crewmate(auditor)'], undefined, 'projectSettings'))
const auditorProjectLine = listingOf(projectDenied).find(line => line.startsWith('- auditor:'))
check('a type denied by a project rule names the shared project settings', auditorProjectLine?.endsWith('launching it is denied by the rule Crewmate(auditor) in the shared project settings.') === true, auditorProjectLine, 'ruleSentence in src/permissions/rules/ruleReason.ts must name the shared project settings for a rule from projectSettings')

console.log('── §2 the rule\'s reason rides on the line ──')
const reasoned = await promptUnder(context(['Crewmate(deployer)'], { 'Crewmate(deployer)': 'deploys are the release lead\'s' }))
const reasonedLine = reasoned.split('\n').find(line => line.startsWith('- deployer:'))
check('the reason follows the sentence', reasonedLine?.endsWith("in your user settings: deploys are the release lead's.") === true, reasonedLine, 'refusalWithReason in src/permissions/rules/ruleReason.ts must append the rule reason after the sentence, and the prompt method of AgentTool (src/tools/crewmate/CrewmateTool.tsx) must pass reasonForRule to it')
const projectReasoned = await promptUnder(context(['Crewmate(auditor)'], { 'Crewmate(auditor)': 'audits run in CI' }, 'projectSettings'))
const projectReasonedLine = projectReasoned.split('\n').find(line => line.startsWith('- auditor:'))
check('a project rule with a reason names the shared project settings and the reason', projectReasonedLine?.endsWith('in the shared project settings: audits run in CI.') === true, projectReasonedLine, 'ruleSentence and refusalWithReason in src/permissions/rules/ruleReason.ts must join the project-settings wording with the reason')

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
check('a launch of the denied type is refused', launchRefusal.includes('is denied by the rule Crewmate(deployer) in your user settings'), launchRefusal, 'buildAgentLaunchPlan in src/crew/crewmates/agentLaunchPlan.ts must throw the ruleSentence refusal for a denied type')

console.log('── §4 refusals: the control ──')
const open = await promptUnder(context([]))
const openOnBase = await promptUnder(context(['Bash(rm *)']))
check('with no deny rule on a type the prompt is byte-identical to the open prompt', open === openOnBase, '', 'the prompt method of AgentTool in src/tools/crewmate/CrewmateTool.tsx must add a refusal only when getDenyRuleForAgent returns a rule for that type')
check('…and no listing line mentions a denial', listingOf(open).every(l => !l.includes(' — ')), '', 'formatAgentLine in src/tools/crewmate/prompt.ts must add the dash and refusal only when a refusal is passed')
const restricted = await promptUnder(context(['Crewmate(deployer)']))
check('a deny on a whole other tool never marks a type', (await promptUnder(context(['Bash']))) === open, '', 'getDenyRuleForAgent as used by the prompt method of AgentTool in src/tools/crewmate/CrewmateTool.tsx must ignore deny rules on other tools')
check('a deny on the Crewmate tool for one type marks exactly that line', listingOf(restricted).filter(l => l.includes(' — launching it is denied')).length === 1, '', 'the prompt method of AgentTool in src/tools/crewmate/CrewmateTool.tsx must mark only the denied type')
const allowedTypes = await AgentTool.prompt!({ getToolPermissionContext: async () => context(['Crewmate(deployer)']) as never, tools: [], agents, allowedAgentTypes: ['auditor'] })
check('a Crewmate(x,y) restriction still narrows the list (a denied type outside it stays off)', !allowedTypes.includes('- deployer:') && allowedTypes.includes('- auditor:'), '', 'getPrompt in src/tools/crewmate/prompt.ts must still apply allowedAgentTypes to the listing')

console.log(failed === 0 ? '\nprove-denied-type-listed: all green' : `\nprove-denied-type-listed: ${failed} FAILURE(S)`)
process.exit(failed === 0 ? 0 : 1)
