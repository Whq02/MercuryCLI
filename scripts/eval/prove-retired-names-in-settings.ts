import { check, cleanup, finish, setup } from './lib.js'
import { CODE_TOOL_SPELLINGS } from '../identity/forbidden-code-tool.js'

setup()
const { getAllBaseTools } = await import('../../src/tools.js')
const { EvalTool } = await import('../../src/tools/EvalTool/EvalTool.js')
const { initializeToolPermissionContext } = await import('../../src/utils/permissions/permissionSetup.js')
const { getDenyRuleForTool, toolAlwaysAllowedRule } = await import('../../src/utils/permissions/decision/rules.js')
const { matchesPattern } = await import('../../src/utils/hooks/matching.js')
const { resolveAgentTools } = await import('../../src/tools/AgentTool/agentToolUtils.js')
const pool = getAllBaseTools()
const warnings: string[][] = []
for (const name of [CODE_TOOL_SPELLINGS[0], 'NoSuchCellRuntime']) {
  const result = await initializeToolPermissionContext({ allowedToolsCli: [name], disallowedToolsCli: [name], permissionMode: 'default', allowDangerouslySkipPermissions: false })
  warnings.push(result.warnings.map(text => text.replaceAll(name, '<name>')))
  check('absent-name allow and deny rules never migrate to Eval', getDenyRuleForTool(result.toolPermissionContext, EvalTool) === null && toolAlwaysAllowedRule(result.toolPermissionContext, EvalTool) === null, `rule name ${name === CODE_TOOL_SPELLINGS[0] ? '(retired spelling)' : name}; an allow or deny rule for a name that is not a tool must not match Eval: see initializeToolPermissionContext in src/utils/permissions/permissionSetup.ts and getDenyRuleForTool in src/utils/permissions/decision/rules.ts`)
  check('the absent hook matcher does not claim Eval', !(await matchesPattern('Eval', name)), 'a hook matcher naming an absent tool must not match Eval: see matchesPattern in src/utils/hooks/matching.ts')
  const resolved = resolveAgentTools({ tools: [name], source: 'userSettings' as never }, pool, true)
  check('an agent tool list uses the generic invalidTools result', resolved.invalidTools.join() === name && resolved.resolvedTools.length === 0, `${JSON.stringify(resolved.invalidTools)}; an unknown name in an agent tool list must land in invalidTools and resolve to no tool: see resolveAgentTools in src/tools/AgentTool/agentToolUtils.ts`)
}
check('warnings follow the identical generic road', JSON.stringify(warnings[0]) === JSON.stringify(warnings[1]), `${JSON.stringify(warnings)}; a retired spelling must produce the same warnings as any unknown name: see initializeToolPermissionContext in src/utils/permissions/permissionSetup.ts`)
for (const language of ['py', 'js'] as const) {
  const matcher = await EvalTool.preparePermissionMatcher({ language, code: '1' }, {} as never)
  check('Eval language and wildcard rules keep their meaning', matcher(language) && matcher('*') && !matcher(language === 'py' ? 'js' : 'py'), `language ${language}; the Eval permission matcher must accept its own language and '*' and refuse the other language: see preparePermissionMatcher in src/tools/EvalTool/EvalTool.ts`)
}
cleanup()
finish('EVAL GENERIC SETTINGS NAMES')
