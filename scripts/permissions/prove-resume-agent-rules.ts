import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const home = mkdtempSync(join(tmpdir(), 'resume-agent-rules-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { assembleToolPool } = await import('../../src/tools.ts')
const { getDenyRuleForTool, toolAlwaysAllowedRule, getAskRuleForTool } = await import('../../src/utils/permissions/decision/rules.ts')
const { wholeToolDenyRulesCovering } = await import('../../src/utils/permissions/ruleReason.ts')
const { resolveAgentTools, filterToolsForAgent } = await import('../../src/tools/AgentTool/agentToolUtils.ts')
const { isReadOnlyAllowlistedTool } = await import('../../src/utils/permissions/readOnlyAllowlist.ts')
const { restrictScoutTools } = await import('../../src/tools/AgentTool/scoutPolicy.ts')
let failures = 0
let checks = 0
const check = (label: string, yes: boolean) => { checks++; if (!yes) failures++; console.log(`[${yes ? 'PASS' : 'FAIL'}] ${label}`) }
const base = getEmptyToolPermissionContext()
const pool = assembleToolPool(base, [])
const names = (tools: readonly { name: string }[]) => tools.map(tool => tool.name)
check('both verbs are in the session pool', names(pool).includes('SendMessage') && names(pool).includes('ResumeCrewmate'))
for (const source of ['userSettings', 'cliArg'] as const) {
  const context = { ...base, alwaysDenyRules: { [source]: ['SendMessage'] } }
  const offered = names(assembleToolPool(context, []))
  check(`${source} SendMessage denial removes both verbs from the pool`, !offered.includes('SendMessage') && !offered.includes('ResumeCrewmate'))
  check(`${source} inherited denial retains its exact reason and source`, getDenyRuleForTool(context, { name: 'ResumeCrewmate' })?.source === source && wholeToolDenyRulesCovering(context, { name: 'ResumeCrewmate' })[0]?.ruleValue.toolName === 'SendMessage')
}
const onlyResume = names(assembleToolPool({ ...base, alwaysDenyRules: { cliArg: ['ResumeCrewmate'] } }, []))
check('ResumeCrewmate denial never widens to SendMessage', onlyResume.includes('SendMessage') && !onlyResume.includes('ResumeCrewmate'))
check('SendMessage allow and ask both cover the resume', toolAlwaysAllowedRule({ ...base, alwaysAllowRules: { cliArg: ['SendMessage'] } }, { name: 'ResumeCrewmate' }) !== null && getAskRuleForTool({ ...base, alwaysAskRules: { cliArg: ['SendMessage'] } }, { name: 'ResumeCrewmate' }) !== null)
check('content-scoped rules do not inherit', getDenyRuleForTool({ ...base, alwaysDenyRules: { cliArg: ['SendMessage(foo)'] } }, { name: 'ResumeCrewmate' }) === null && wholeToolDenyRulesCovering({ ...base, alwaysDenyRules: { cliArg: ['SendMessage(foo)'] } }, { name: 'ResumeCrewmate' }).length === 0)
const definition = { source: 'projectSettings', tools: ['Read', 'SendMessage'] } as never
const declared = names(resolveAgentTools(definition, pool).resolvedTools)
check('a saved definition listing SendMessage gets both verbs', declared.includes('SendMessage') && declared.includes('ResumeCrewmate'))
const denied = names(resolveAgentTools({ ...definition as object, disallowedTools: ['SendMessage'] } as never, pool).resolvedTools)
check('a saved definition denying SendMessage loses both verbs', !denied.includes('SendMessage') && !denied.includes('ResumeCrewmate'))
const narrow = names(resolveAgentTools({ ...definition as object, disallowedTools: ['ResumeCrewmate'] } as never, pool).resolvedTools)
check('a definition can deny only the resume', narrow.includes('SendMessage') && !narrow.includes('ResumeCrewmate'))
const scoped = names(resolveAgentTools({ source: 'projectSettings', tools: ['SendMessage(foo)'] } as never, pool).resolvedTools)
check('a content-scoped declared entry does not inherit', !scoped.includes('ResumeCrewmate'))
const background = names(filterToolsForAgent({ tools: pool, isBuiltIn: true }))
check('a crewmate (foreground or background, one filter) can hold both verbs', background.includes('SendMessage') && background.includes('ResumeCrewmate'))
const scout = names(restrictScoutTools(pool))
check('the scout holds neither verb', !scout.includes('SendMessage') && !scout.includes('ResumeCrewmate'))
check('the Flow read-only allowlist holds both verbs', isReadOnlyAllowlistedTool('SendMessage') && isReadOnlyAllowlistedTool('ResumeCrewmate'))
console.log(`resume-agent-rules: ${checks} checks, ${failures} failed`)
rmSync(home, { recursive: true, force: true })
process.exit(failures ? 1 : 0)
