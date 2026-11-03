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
check('Git names its own work without describing another tool', prompt.startsWith('Inspect local repositories') && !/Bash|\bRead\b|optional typed/.test(prompt), prompt)
check('the description stays under 300 bytes without a second operation schema', Buffer.byteLength(prompt) <= 300 && !prompt.includes('op:"'), prompt)
check('the repository workflow still names Bash and the quoted-heredoc commit', rules.includes('run by the Bash tool') && rules.includes('git commit -m "$(cat <<\'EOF\''), rules)
const { zodToJsonSchema } = await import('../../src/utils/zodToJsonSchema.ts')
const fields = (zodToJsonSchema(GitTool.inputSchema) as any).properties
check('plan preview and partial-commit effects live in their fields', fields.groups.description.includes('without committing') && fields.planId.description.includes('earlier groups stay committed if a later group fails') && !prompt.includes('later group'), JSON.stringify(fields.planId))
check('history reads and comparison retain their field meanings', fields.ref.description.includes('fileAtRef/tree') && fields.path.description.includes('optional directory') && fields.refA.description.includes('compare: base') && fields.refB.description.includes('compare: head'))
console.log(`git-commit-road: ${failures} failures`)
process.exit(failures ? 1 : 0)
