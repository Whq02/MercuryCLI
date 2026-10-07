;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { GitTool } = await import('../../src/tools/GitTool/GitTool.ts')
const { gitRulesText } = await import('../../src/utils/gitRules.ts')
const prompt = await GitTool.prompt({} as never)
const rules = gitRulesText()
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail}`}`)
}
check('Git defers ordinary commits to the repository workflow through Bash', prompt.split('\n')[0]!.includes('repository commit workflow uses Bash'), prompt.split('\n')[0])
check('Git offers typed plans without claiming precedence over Bash', !prompt.includes('Use this over git in Bash') && prompt.includes('optional'), prompt.split('\n')[0])
check('the repository workflow still names Bash and the quoted-heredoc commit', rules.includes('each through the Bash tool') && rules.includes('git commit -m "$(cat <<\'EOF\''), rules)
check('the explicitly requested typed plan road remains available', prompt.includes('op:"plan"') && prompt.includes('op:"apply"') && prompt.includes('COMMITS NOTHING'), prompt)
console.log(`git-commit-road: ${failures} failures`)
process.exit(failures ? 1 : 0)
