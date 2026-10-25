import assert from 'node:assert/strict'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { formatCommandsWithinBudget } = await import('../../src/tools/SkillTool/prompt.js')
const command = (description: string) => ({ name: 'check', description, type: 'prompt' }) as any
for (const separator of [' ', '\t', '\n', '\u00a0']) {
  const prefix = 'word '.repeat(48).trim()
  const description = `${prefix}${separator}abcdefghijklmnopqrstuvwxy`
  const listed = formatCommandsWithinBudget([command(description)], 100_000)
  assert.equal(listed, `- check: ${prefix}…`, 'the per-entry cap ends at any whitespace boundary')
}
process.env.MERCURY_SKILL_CHAR_BUDGET = '40'
assert.equal(formatCommandsWithinBudget([command('Check the entire configuration before changing anything.')]), '- check: Check the entire configuration…')
delete process.env.MERCURY_SKILL_CHAR_BUDGET
assert.equal(formatCommandsWithinBudget([command('a'.repeat(300))], 100_000), `- check: ${'a'.repeat(249)}…`)
console.log('skill description boundaries: PASS')
