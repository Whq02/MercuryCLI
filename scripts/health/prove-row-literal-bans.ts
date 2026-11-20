#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { healthRowLiterals, literalsOfSource, LITERAL_BAN_LINE } from '../lib/healthRowLiterals.ts'

let failures = 0
function check(label: string, cond: boolean, detail: string[] = []): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
  if (!cond) for (const line of detail) console.log(`         ${line}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

console.log(LITERAL_BAN_LINE)
console.log('The bans that stand on this reader: the retired crew words (scripts/engine-connector/prove-crew-vocabulary.ts), the settings keys the schema refuses (scripts/health/prove-remedy-keys-exist.ts), a platform named in the embedder row (scripts/identity/prove-embed-pack-everywhere-words.ts). This proof holds the reader to every row of the list, so that none of the three reads less than the rows.')

section('1. the reader bites: both arms of a condition, a template around its holes, a row by its id; a module path is not a word')
{
  const poison = [
    "import { x } from './poison-module.js'",
    "const lazy = () => import('./poison-lazy.js')",
    'export function poisonChecks(flag: boolean) {',
    '  return [',
    '    {',
    "      id: 'poison-row',",
    "      label: 'Poison',",
    '      run: () => ({',
    "        status: flag ? 'ok' : 'warn',",
    '        evidence: `left ${x} middle ${x} right`,',
    "        fix: flag ? 'the arm a state prints' : 'the arm no state prints',",
    '      }),',
    '    },',
    '    {',
    '      id: `poison-${x}`,',
    "      label: 'Computed',",
    "      run: () => ({ status: 'ok', evidence: 'a row whose id is computed' }),",
    '    },',
    '  ]',
    '}',
  ].join('\n')
  const read = literalsOfSource('poison.ts', poison)
  const ofRow = read.filter(literal => literal.row === 'poison-row').map(literal => literal.text)
  check('both arms of a condition are read, and a template is read around its holes', ofRow.includes('the arm a state prints') && ofRow.includes('the arm no state prints') && ofRow.some(text => /^left\s+middle\s+right$/.test(text)), ofRow)
  check('a string is laid to the row it stands in, and to the function that builds it', read.some(literal => literal.row === 'poison-*' && literal.text === 'a row whose id is computed') && read.every(literal => literal.row === null || literal.unit === 'poisonChecks'), read.map(literal => `${literal.row} ${literal.unit} ${literal.text}`))
  check('a module path is not a word of the rows', !read.some(literal => literal.text.includes('poison-module') || literal.text.includes('poison-lazy')), read.map(literal => literal.text))
}

section('2. the reader reaches every row of the list')
{
  const read = healthRowLiterals()
  const { HEALTH_SECTIONS } = await import('../../src/services/health/sections.ts')
  const { healthContext } = await import('../../src/services/health/healthReport.ts')
  const context = await healthContext()
  check(
    `the compiler program follows the report's import of the list to the list and to each section's module with its parts (${read.files.length} modules for ${HEALTH_SECTIONS.length} sections, ${read.literals.length} strings, ${read.ms}ms)`,
    read.sections.length === HEALTH_SECTIONS.length && read.sections.every(door => read.literals.some(literal => literal.file === door || literal.file.startsWith(door.replace(/\.tsx?$/, '/')))),
    [`modules read: ${read.files.join(' ')}`, 'the reader starts at src/utils/healthReport.ts, finds the module that exports HEALTH_SECTIONS among its imports and reads every module that one imports, each with the modules it imports from the folder of its own name beside it: a section that is listed another way is not read, and no ban holds it'],
  )
  const unread: string[] = []
  let rows = 0
  for (const entry of HEALTH_SECTIONS) {
    for (const row of await entry.checks(context)) {
      rows++
      const known = read.rows.includes(row.id) || read.rows.some(pattern => pattern.endsWith('*') && row.id.startsWith(pattern.slice(0, -1)))
      if (!known) unread.push(`the row '${row.id}' of the section '${entry.id}' is returned by the list and the reader found no object with that id and a run function in the modules it read: write the row as a literal with its id beside its run, or the bans do not read its words`)
    }
  }
  check(`every row the list returns here is a row the reader read (${rows} rows; ${read.rows.length} read, the rows of arms this machine does not build among them)`, rows > 100 && unread.length === 0, unread)
}

console.log('')
console.log(failures === 0 ? 'prove-row-literal-bans: the bans read every row' : `prove-row-literal-bans: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
