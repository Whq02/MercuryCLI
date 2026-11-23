import { join } from 'node:path'

const ROOT = process.cwd()
let fail = 0
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) fail = 1
}
const vocabulary = (await import(join(ROOT, 'src/engine/rows/vocabulary.ts'))) as Record<string, unknown>
const sentence = vocabulary.hookEndingSentence as ((ending: Record<string, unknown>, hook: { name: string; event: string }) => string) | undefined
const classes = vocabulary.HOOK_ENDING_CLASSES as readonly string[] | undefined
const hook = { name: 'guard', event: 'tool.before' }
const say = (ending: Record<string, unknown>): string => (sentence ? sentence(ending, hook) : '')
const endings = [
  { status: 'failed', class: 'cancelled', exit_code: 1 },
  { status: 'failed', class: 'timed_out', exit_code: 143, detail: '1s' },
  { status: 'failed', class: 'exit', exit_code: 3, detail: 'no such file' },
  { status: 'failed', class: 'spawn', exit_code: 1, detail: 'no such shell' },
  { status: 'failed', class: 'answer', exit_code: 0, detail: '`permission` is not an answer tool.before reads' },
]
const lines = endings.map(say)

console.log(' hook endings — one typed row, one writer of its words')
check('the row vocabulary carries the five hook ending classes and no other', Array.isArray(classes) && classes.join(',') === 'cancelled,timed_out,exit,spawn,answer')
check('the five endings produce five different lines, each naming the hook and the event', new Set(lines).size === 5 && lines.every(l => l.startsWith('hook guard (tool.before) ')), lines.join(' | '))
check('a non-zero exit names its code and the stderr', lines[2] === 'hook guard (tool.before) failed with exit 3: no such file', lines[2])
check('a timeout names the budget and that the guarded event proceeded', lines[1] === 'hook guard (tool.before) timed out after 1s and was killed; the tool.before it guarded proceeded', lines[1])
check('an answer outside the shape names the refusal', String(lines[4]).includes('`permission` is not an answer tool.before reads'), lines[4])
check('a clean ending reads exit 0', say({ status: 'ok', exit_code: 0 }) === 'hook guard (tool.before) ended with exit 0')
const secondsWord = vocabulary.secondsWord as ((ms: number) => string) | undefined
check('the budget word keeps a fraction of a second: 1.5s, never 2s', secondsWord !== undefined && secondsWord(1500) === '1.5s' && secondsWord(30_000) === '30s')
process.exit(fail)
