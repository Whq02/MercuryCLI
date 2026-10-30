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
const routing = 'Use when the user asks to change Mercury keyboard shortcuts: rebind an action, add a chord sequence, bind a slash command to a key, unbind a default, or fix keybinding errors reported by /health.'
assert.equal(formatCommandsWithinBudget([command(`${routing} Carries the file layers, the keystroke grammar, and the chord table for the answer.`)], 100_000), `- check: ${routing}`, 'a sentence that ends past seven tenths of the cap closes the entry whole, with no dangling fragment')
const early = 'Short lead sentence. ' + 'word '.repeat(60).trim()
const earlyListed = formatCommandsWithinBudget([command(early)], 100_000)
assert.ok(earlyListed.startsWith('- check: Short lead sentence. word word') && earlyListed.endsWith('word…') && earlyListed.length > 200, 'a sentence end before seven tenths of the cap does not close the entry early: the word clip keeps the routing words')
const joined = { name: 'check', description: 'Runs a thing on a cadence.', whenToUse: 'Use when work should re-run: polling a build, watching a queue, periodic upkeep. A single future tick is not this skill, use the scheduler for that; a watch that never ends belongs to Monitor, and a one-off run to Bash.', type: 'prompt' } as any
assert.equal(formatCommandsWithinBudget([joined], 100_000), '- check: Runs a thing on a cadence. - Use when work should re-run: polling a build, watching a queue, periodic upkeep. A single future tick is not this skill, use the scheduler for that; a watch that never ends belongs to Monitor, and a one-off run to Bash.', 'an entry under the cap rides whole')
console.log('skill description boundaries: PASS')
