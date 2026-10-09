import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
let fail = 0
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) fail = 1
}
const src = (p: string): string => readFileSync(join(ROOT, p), 'utf8')
const vocabulary = (await import(join(ROOT, 'src/rows/vocabulary.ts'))) as Record<string, unknown>
const sentence = vocabulary.hookEndingSentence as ((ending: Record<string, unknown>, hook: { name: string; event: string }) => string) | undefined
const classes = vocabulary.HOOK_ENDING_CLASSES as readonly string[] | undefined
const hook = { name: 'guard', event: 'tool.before' }
const say = (ending: Record<string, unknown>): string => (sentence ? sentence(ending, hook) : '')
const endings = [
  { status: 'failed', class: 'closed_pipe', exit_code: 1 },
  { status: 'failed', class: 'cancelled', exit_code: 1 },
  { status: 'failed', class: 'timed_out', exit_code: 143, detail: '1s' },
  { status: 'failed', class: 'exit', exit_code: 3, detail: 'no such file' },
  { status: 'failed', class: 'spawn', exit_code: 1, detail: 'no such shell' },
  { status: 'failed', class: 'answer', exit_code: 0, detail: '`permission` is not an answer tool.before reads' },
]
const lines = endings.map(say)

console.log(' hook endings — one typed row, one writer of its words')
check('the row vocabulary carries the six hook ending classes', Array.isArray(classes) && ['closed_pipe', 'cancelled', 'timed_out', 'exit', 'spawn', 'answer'].every(c => classes.includes(c)))
check('the six endings produce six different lines, each naming the hook and the event', new Set(lines).size === 6 && lines.every(l => l.startsWith('hook guard (tool.before) ')), lines.join(' | '))
check('a non-zero exit names its code and the stderr', lines[3] === 'hook guard (tool.before) failed with exit 3: no such file', lines[3])
check('a timeout names the budget and that the guarded event proceeded', lines[2] === 'hook guard (tool.before) timed out after 1s and was killed; the tool.before it guarded proceeded', lines[2])
check('an answer outside the shape names the refusal', String(lines[5]).includes('`permission` is not an answer tool.before reads'), lines[5])
check('a clean ending reads exit 0', say({ status: 'ok', exit_code: 0 }) === 'hook guard (tool.before) ended with exit 0')
const secondsWord = vocabulary.secondsWord as ((ms: number) => string) | undefined
check('the budget word keeps a fraction of a second: 1.5s, never 2s', secondsWord !== undefined && secondsWord(1500) === '1.5s' && secondsWord(30_000) === '30s')
const runner = src('src/utils/hooks/commandRunner.ts')
const fire = src('src/utils/hooks/fire.ts')
check('the command runner builds every ending as a row and never writes a line itself', /class: 'closed_pipe'/.test(runner) && /class: 'cancelled'/.test(runner) && /class: 'timed_out'/.test(runner) && /class: 'spawn'/.test(runner) && !runner.includes('hookEndingSentence('))
check('the fire asks the one writer for the words of every failed hook', fire.includes('hookEndingSentence(') && /class: 'exit'/.test(fire) && /class: 'answer'/.test(fire) && /class: 'spawn'/.test(fire))
check('no hand-written ending line remains in the runner or the fire', !/closed stdin before|Error occurred while executing hook|Failed with non-blocking status|timed out after \$\{seconds\}/.test(runner + fire))
const { HOOK_CUT_BUDGET_MS } = (await import(join(ROOT, 'src/utils/hooks/contract.ts'))) as { HOOK_CUT_BUDGET_MS: number }
check('the session.end budget the light shutdown installer carries is the one cut budget of the table', HOOK_CUT_BUDGET_MS === 1_500 && src('src/utils/gracefulShutdown.ts').includes('const SESSION_END_HOOK_BUDGET_MS = 1_500'))
if (existsSync(join(ROOT, 'sdk/src/rows.ts'))) check('the SDK vocabulary carries the same row', src('sdk/src/rows.ts').includes('HookEnding'))
check('the hooks page says a failure is one line, saved with the session', src('docs/HOOKS.md').includes('a failure is one line') && src('docs/HOOKS.md').includes('Every line is saved with the'))
process.exit(fail)
