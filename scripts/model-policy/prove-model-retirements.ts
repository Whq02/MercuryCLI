// gate-watch: src/utils/model/deprecation.ts
import { getModelDeprecationWarning } from '../../src/utils/model/deprecation.ts'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}
const tense = (date: string): string => (Date.parse(date) < Date.now() ? 'was retired' : 'will be retired')

console.log('Model retirement notices: the dated Anthropic rows warn, the live rows stay quiet')
for (const [id, name, date] of [
  ['claude-sonnet-4-5', 'Claude Sonnet 4.5', 'November 30, 2026'],
  ['claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5', 'November 30, 2026'],
  ['claude-opus-4-1-20250805', 'Claude Opus 4.1', 'August 5, 2026'],
  ['claude-sonnet-4-20250514', 'Claude Sonnet 4', 'June 15, 2026'],
  ['claude-opus-4-20250514', 'Claude Opus 4', 'June 15, 2026'],
  ['claude-3-7-sonnet-20250219', 'Claude 3.7 Sonnet', 'February 19, 2026'],
] as const) {
  const warning = getModelDeprecationWarning(id)
  check(`${id} says ${name} ${tense(date)} on ${date}`, warning !== null && warning.includes(`${name} ${tense(date)} on ${date}`), String(warning))
}
for (const id of ['claude-sonnet-4-6', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-haiku-5-5', 'gpt-6-astra']) {
  check(`${id} carries no retirement notice`, getModelDeprecationWarning(id) === null, String(getModelDeprecationWarning(id)))
}
check('an empty id carries no notice', getModelDeprecationWarning('') === null && getModelDeprecationWarning(undefined) === null)

console.log(`\n${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
