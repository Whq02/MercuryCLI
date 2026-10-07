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
  check('absent-name allow and deny rules never migrate to Eval', getDenyRuleForTool(result.toolPermissionContext, EvalTool) === null && toolAlwaysAllowedRule(result.toolPermissionContext, EvalTool) === null)
  check('the absent hook matcher does not claim Eval', !matchesPattern('Eval', name))
  const resolved = resolveAgentTools({ tools: [name], source: 'userSettings' as never }, pool, false, true)
  check('an agent tool list uses the generic invalidTools result', resolved.invalidTools.join() === name && resolved.resolvedTools.length === 0, JSON.stringify(resolved.invalidTools))
}
check('warnings follow the identical generic road', JSON.stringify(warnings[0]) === JSON.stringify(warnings[1]), JSON.stringify(warnings))
for (const language of ['py', 'js'] as const) {
  const matcher = await EvalTool.preparePermissionMatcher({ language, code: '1' }, {} as never)
  check('Eval language and wildcard rules keep their meaning', matcher(language) && matcher('*') && !matcher(language === 'py' ? 'js' : 'py'))
}
cleanup()
finish('EVAL GENERIC SETTINGS NAMES')
