import { check, cleanup, finish, setup } from './lib.js'
import { CODE_TOOL_SPELLINGS } from '../identity/forbidden-code-tool.js'
function hinted(label: string, cond: boolean, detail: string, hint: string): void {
  check(label, cond, cond ? detail : `${detail ? `${detail} | ` : ''}${hint}`)
}

setup()
const { getAllBaseTools } = await import('../../src/tools/kit/toolList.js')
const { EvalTool } = await import('../../src/tools/eval/EvalTool.js')
const { initializeToolPermissionContext } = await import('../../src/permissions/rules/permissionSetup.js')
const { getDenyRuleForTool, toolAlwaysAllowedRule } = await import('../../src/permissions/rules/decision/rules.js')
const { matchesPattern } = await import('../../src/integrations/event-hooks/matching.js')
const { resolveAgentTools } = await import('../../src/tools/crewmate/crewmateLifecycle.js')
const pool = getAllBaseTools()
const warnings: string[][] = []
for (const name of [CODE_TOOL_SPELLINGS[0], 'NoSuchCellRuntime']) {
  const result = await initializeToolPermissionContext({ allowedToolsCli: [name], disallowedToolsCli: [name], permissionMode: 'default', allowDangerouslySkipPermissions: false })
  warnings.push(result.warnings.map(text => text.replaceAll(name, '<name>')))
  hinted('absent-name allow and deny rules never migrate to Eval', getDenyRuleForTool(result.toolPermissionContext, EvalTool) === null && toolAlwaysAllowedRule(result.toolPermissionContext, EvalTool) === null, '', 'a retired or unknown tool name in allowed or disallowed tool settings must not resolve to Eval; see initializeToolPermissionContext in src/permissions/rules/permissionSetup.ts and getDenyRuleForTool in src/permissions/rules/decision/rules.ts')
  hinted('the absent hook matcher does not claim Eval', !(await matchesPattern('Eval', name)), '', 'fix matchesPattern in src/integrations/event-hooks/matching.ts so a retired or unknown name does not match the Eval tool')
  const resolved = resolveAgentTools({ tools: [name], source: 'userSettings' as never }, pool, true)
  hinted('an agent tool list uses the generic invalidTools result', resolved.invalidTools.join() === name && resolved.resolvedTools.length === 0, JSON.stringify(resolved.invalidTools), 'fix resolveAgentTools in src/tools/crewmate/crewmateLifecycle.ts so an unknown tool name lands in invalidTools and resolves to nothing')
}
hinted('warnings follow the identical generic road', JSON.stringify(warnings[0]) === JSON.stringify(warnings[1]), JSON.stringify(warnings), 'initializeToolPermissionContext in src/permissions/rules/permissionSetup.ts must give a retired name the same warnings as any unknown name')
for (const language of ['py', 'js'] as const) {
  const matcher = await EvalTool.preparePermissionMatcher({ language, code: '1' }, {} as never)
  hinted('Eval language and wildcard rules keep their meaning', matcher(language) && matcher('*') && !matcher(language === 'py' ? 'js' : 'py'), '', 'fix preparePermissionMatcher in src/tools/eval/EvalTool.ts so a rule matches its own language and the wildcard only')
}
cleanup()
finish('EVAL GENERIC SETTINGS NAMES')
