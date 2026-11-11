#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { join } from 'node:path'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const SRC = join(ROOT, 'src')
for (const key of ['MERCURY_SPAWNED_BY', 'MERCURY_WARDS', 'MERCURY_SKIP_PERMISSIONS']) delete process.env[key]

const { AUTONOMOUS_WARDS, REFUSAL_WARDS, evaluateWards } = await import(join(SRC, 'utils/wards/wards.ts'))
const { judgeGrowth } = await import(join(ROOT, 'scripts/lib/linearGrowth.ts'))
type Work = Partial<Record<'characters' | 'steps' | 'regexEvaluations', number>>

const DELETE_RULES = [...REFUSAL_WARDS, ...AUTONOMOUS_WARDS].filter((rule: { name: string }) => rule.name === 'no-root-recursive-delete' || rule.name === 'no-home-recursive-delete')
const words = (count: number): string => `echo${' rm'.repeat(count)}`
function reading(command: string): { refused: boolean; work: Required<Work> } {
  const work: Work = {}
  const verdict = evaluateWards(DELETE_RULES, { toolName: 'Bash', input: { command }, shellCommand: command }, work)
  return { refused: !verdict.allow, work: { characters: work.characters ?? 0, steps: work.steps ?? 0, regexEvaluations: work.regexEvaluations ?? 0 } }
}

console.log('============================================================')
console.log(' the delete wards read a line of delete verbs once')
console.log('============================================================')

section('§1 a line of n delete verbs with nothing to delete: each verb is walked once and the pattern is tried once a segment')
{
  const sizes = [1_000, 2_000, 4_000, 8_000]
  const read = sizes.map(size => ({ size, ...reading(`${words(size)}; ls`) }))
  check('none of the lines is refused', read.every(row => !row.refused))
  const grown = read.slice(1).map((row, at) => row.work.steps - read[at]!.work.steps)
  const perVerb = grown[0]! / (sizes[1]! - sizes[0]!)
  check('the walk counts every verb: the steps grow with the verbs', perVerb >= 1 && Number.isInteger(perVerb), `steps ${read.map(row => row.work.steps).join(', ')}`)
  check('they grow by the same count a verb at every size', grown.every((growth, at) => growth === perVerb * (sizes[at + 1]! - sizes[at]!)), `growth ${grown.join(', ')} for ${perVerb} a verb`)
  check('the pattern is tried the same number of times whatever the count of verbs', read.every(row => row.work.regexEvaluations === read[0]!.work.regexEvaluations), read.map(row => row.work.regexEvaluations).join(', '))
  const characters = judgeGrowth(read.map(row => ({ size: row.size, ms: row.work.characters })), { slackMs: 0 })
  check('the characters read grow no faster than the line', characters.linear, characters.summary)
  const steps = judgeGrowth(read.map(row => ({ size: row.size, ms: row.work.steps })), { slackMs: 0 })
  check('the steps grow no faster than the line', steps.linear, steps.summary)
}

section('§2 the same verbs in n segments: one try a segment')
{
  const sizes = [500, 1_000, 2_000]
  const read = sizes.map(size => ({ size, ...reading(`${'rm x; '.repeat(size)}ls`) }))
  check('none is refused', read.every(row => !row.refused))
  const tries = judgeGrowth(read.map(row => ({ size: row.size, ms: row.work.regexEvaluations })), { slackMs: 0 })
  check('the tries grow with the segments and no faster', tries.linear && read[2]!.work.regexEvaluations > read[0]!.work.regexEvaluations, tries.summary)
}

section('§3 what the wards refuse stays refused at every size')
{
  for (const size of [1, 1_000, 50_000]) {
    check(`${size} verbs, then a delete of the home in its own segment`, reading(`${words(size)}; rm -rf ~`).refused)
    check(`${size} verbs in the segment that ends in the home: the first verb decides`, reading(`rm${' rm'.repeat(size)} -rf ~`).refused)
    check(`${size} verbs, then a delete of the root after a pipe`, reading(`${words(size)} | rm -rf /`).refused)
    check(`${size} verbs and a delete inside a scratch folder stays clear`, !reading(`${words(size)}; rm -rf /tmp/x`).refused)
  }
  check('a delete verb later in a segment whose first verb has no target still decides nothing wrong: a flag and a root behind the first verb refuse', reading('rm a b c; echo rm -rf ~').refused)
  check('a segment whose only root stands before its verbs is clear, as before', !reading('ls ~ rm rm rm').refused)
}

console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? ` ✅ delete wards · one reading a segment: ${checks} checks, 0 failures` : ` ❌ delete wards · one reading a segment: ${failures} of ${checks} checks failed`)
process.exit(failures === 0 ? 0 : 1)
