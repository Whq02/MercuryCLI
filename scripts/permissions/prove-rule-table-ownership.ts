import '../lib/hermetic.js'
import { join } from 'node:path'
const root = process.argv[2] ?? join(import.meta.dir, '../..')
const rules = await import(join(root, 'src/permissions/rules/decision/rules.ts'))
const { getEmptyToolPermissionContext } = await import(join(root, 'src/tools/kit/tool.ts'))
let failures = 0
const check = (label: string, condition: boolean) => {
  const hint = 'fix the rule caching in getAllowRules, getDenyRules or getDenyRuleForTool in src/permissions/rules/decision/rules.ts: a cache must follow in-place edits of the context and hand each caller its own copy'
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${condition ? '' : ' — ' + hint}`)
  if (!condition) failures++
}
const context = () => ({ ...getEmptyToolPermissionContext(), alwaysDenyRules: { userSettings: ['Read'] } })
{
  const ctx = context()
  rules.getAllowRules(ctx)
  ctx.alwaysDenyRules.userSettings.push('Bash')
  check('an in-place source edit is visible to the same permission context', rules.getDenyRuleForTool(ctx, { name: 'Bash' }) !== null)
}
{
  const ctx = context()
  const handedOut = rules.getDenyRules(ctx)
  handedOut.length = 0
  check('a caller owns its getter array, not the evaluated rule ledger', rules.getDenyRuleForTool(ctx, { name: 'Read' }) !== null)
}
{
  const ctx = context()
  const row = rules.getDenyRuleForTool(ctx, { name: 'Read' })!
  row.ruleValue.toolName = 'Bash'
  check('a caller owns its decision row, not a cached parsed value', rules.getDenyRuleForTool(ctx, { name: 'Read' }) !== null)
}
console.log(failures ? `prove-rule-table-ownership: ${failures} FAILURE(S)` : 'prove-rule-table-ownership: all green')
process.exitCode = failures ? 1 : 0
