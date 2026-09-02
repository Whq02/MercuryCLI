// ============================================================================
//  prove-skill-catalogue-truncation — FN-013 MCP-05: skill-catalogue
//  degradation is VISIBLE, never silent. The budget formatter reports what
//  it did (name-only entries, withheld names) in a machine-readable record;
//  the attachment renders a one-line model-facing note naming the counts
//  and the recovery path; a within-budget listing is byte-identical with no
//  record. The description is the entire selection signal the Skill tool's
//  prompt instructs the model to sweep — a name-only entry is effectively
//  unselectable, and before this law the formatter fell to it silently.
//
//    §1 within budget: full listing, truncation null (byte-identical arm).
//    §2 the allowance boundary, EXACT: one budget char above the name-only
//       fall carries no record; one below carries it — never one entry
//       earlier.
//    §3 withholding: when even name-only lines overflow, trailing names
//       withhold AND COUNT; a bundled-only overflow stays the deliberate
//       full listing with no record.
//    §4 the render arm: the note names both counts; a persisted legacy
//       attachment (no truncation field) renders without the note and
//       never throws.
//
//  Pure and hermetic: the formatter and renderer drive on synthetic
//  commands under the SLASH_COMMAND_TOOL_CHAR_BUDGET contract seam.
//  Run:  ~/.bun/bin/bun run scripts/skills/prove-skill-catalogue-truncation.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (s: string): void => console.log(`\n── ${s} ──`)

console.log('============================================================')
console.log(' skill catalogue truncation — stated, never silent')
console.log('============================================================')

const prompt = await import('../../src/tools/SkillTool/prompt.ts')

type Cmd = { type: string; name: string; description: string; loadedFrom?: string }
const skill = (name: string, description: string, loadedFrom = 'skills'): Cmd => ({
  type: 'prompt',
  name,
  description,
  loadedFrom,
})
const longDesc = 'a deliberately long selection signal '.repeat(4).trim()
const pair = [skill('alpha', longDesc), skill('omega', longDesc)] as never[]

const withBudget = <T>(budget: number, run: () => T): T => {
  const prior = process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET
  process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET = String(budget)
  try {
    return run()
  } finally {
    if (prior === undefined) delete process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET
    else process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET = prior
  }
}

section('§1 within budget — full listing, no record')
{
  const { content, truncation } = withBudget(10_000, () => prompt.formatCommandsWithinBudgetDetailed(pair))
  t('the full descriptions ride', content === `- alpha: ${longDesc}\n- omega: ${longDesc}`, content.slice(0, 80))
  t('no truncation record', truncation === null, JSON.stringify(truncation))
  t('the string view agrees byte-for-byte', withBudget(10_000, () => prompt.formatCommandsWithinBudget(pair)) === content)
}

section('§2 the allowance boundary, exact')
{
  // Two non-bundled entries, 5-char names: nameOverhead (5+4)*2 = 18,
  // one joining newline ⇒ allowance = floor((budget-19)/2). The name-only
  // fall begins strictly below the 20-char allowance: budget 59 ⇒ 20 (no
  // record), budget 58 ⇒ 19 (record) — the note fires at the boundary and
  // not one entry earlier.
  const above = withBudget(59, () => prompt.formatCommandsWithinBudgetDetailed(pair))
  t('one char above the fall: descriptions shortened, still present, NO record', above.truncation === null && above.content.includes('- alpha: '), JSON.stringify(above))
  const below = withBudget(58, () => prompt.formatCommandsWithinBudgetDetailed(pair))
  t(
    'one char below: BOTH entries name-only, the record names the budget and the counts',
    below.truncation !== null && below.truncation.budgetChars === 58 && below.truncation.nameOnly === 2 && below.truncation.withheld === 0 && below.content === '- alpha\n- omega',
    JSON.stringify(below),
  )
}

section('§3 withholding — counted, bounded; bundled-only overflow exempt')
{
  const tight = withBudget(12, () => prompt.formatCommandsWithinBudgetDetailed(pair))
  t(
    'a 12-char budget keeps one name and withholds the other, both counted',
    tight.truncation !== null && tight.truncation.nameOnly === 1 && tight.truncation.withheld === 1 && tight.content === '- alpha',
    JSON.stringify(tight),
  )
  const none = withBudget(5, () => prompt.formatCommandsWithinBudgetDetailed(pair))
  t(
    'a 5-char budget withholds both (nothing silently absent — the count says so)',
    none.truncation !== null && none.truncation.nameOnly === 0 && none.truncation.withheld === 2 && none.content === '',
    JSON.stringify(none),
  )
  const bundledOnly = [skill('debug', longDesc, 'bundled'), skill('review', longDesc, 'bundled')] as never[]
  const bundled = withBudget(12, () => prompt.formatCommandsWithinBudgetDetailed(bundledOnly))
  t(
    'a bundled-only overflow stays the deliberate full listing, no record',
    bundled.truncation === null && bundled.content.includes(`- debug: ${longDesc}`),
    JSON.stringify(bundled.truncation),
  )
}

section('§4 the render arm and the legacy shape')
{
  const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.ts')
  const noted = JSON.stringify(
    normalizeAttachmentForAPI({
      type: 'skill_listing',
      content: '- alpha\n- omega',
      skillCount: 2,
      isInitial: true,
      removedNames: [],
      truncation: { budgetChars: 58, nameOnly: 2, withheld: 1 },
    } as never),
  )
  t(
    'the note names the name-only count, the invocation recovery path and the withheld count',
    noted.includes('2 of the entries above list name-only') && noted.includes('available on invocation') && noted.includes('1 further skill name(s) were withheld'),
    noted.slice(0, 240),
  )
  const clean = JSON.stringify(
    normalizeAttachmentForAPI({
      type: 'skill_listing',
      content: '- alpha: full words',
      skillCount: 1,
      isInitial: true,
      removedNames: [],
      truncation: null,
    } as never),
  )
  t('a clean listing renders no note', !clean.includes('name-only') && clean.includes('alpha: full words'))
  let legacyThrew = false
  let legacyText = ''
  try {
    legacyText = JSON.stringify(
      normalizeAttachmentForAPI({ type: 'skill_listing', content: '- old: a skill', skillCount: 1, isInitial: true } as never),
    )
  } catch {
    legacyThrew = true
  }
  t('a persisted legacy listing renders without the note and never throws', !legacyThrew && legacyText.includes('old: a skill') && !legacyText.includes('name-only'))
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ prove-skill-catalogue-truncation — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ prove-skill-catalogue-truncation — all checks pass')
process.exit(0)
