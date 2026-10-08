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
const hook = { name: 'guard', event: 'PreToolUse' }
const say = (ending: Record<string, unknown>): string => (sentence ? sentence(ending, hook) : '')
const endings = [
  { status: 'failed', class: 'closed_pipe', exit_code: 1 },
  { status: 'failed', class: 'cancelled', exit_code: 1 },
  { status: 'failed', class: 'timed_out', exit_code: 143, detail: '1s' },
  { status: 'failed', class: 'exit', exit_code: 3, detail: 'no such file' },
]
const lines = endings.map(say)

console.log(' hook endings — one typed row, one writer of its words')
check('the row vocabulary carries the hook ending classes', Array.isArray(classes) && ['closed_pipe', 'cancelled', 'timed_out', 'exit', 'spawn'].every(c => classes.includes(c)))
check('the four endings produce four different lines, each naming the hook and the event', new Set(lines).size === 4 && lines.every(l => l.startsWith('hook guard (PreToolUse) ')), lines.join(' | '))
check('a non-zero exit names its code and the stderr', lines[3] === 'hook guard (PreToolUse) failed with exit 3: no such file', lines[3])
check('a timeout names the budget and that the guarded event proceeded', lines[2] === 'hook guard (PreToolUse) timed out after 1s and was killed; the PreToolUse it guarded proceeded', lines[2])
check('a clean ending reads exit 0', say({ status: 'ok', exit_code: 0 }) === 'hook guard (PreToolUse) ended with exit 0')
check('the runner builds the ending as a row and asks the writer for the words', /class: 'closed_pipe'/.test(src('src/utils/hooks/execution.ts')) && /class: 'cancelled'/.test(src('src/utils/hooks/execution.ts')) && /class: 'spawn'/.test(src('src/utils/hooks/execution.ts')) && src('src/utils/hooks/execution.ts').includes('hookEndingSentence('))
check('the engine asks the writer for the timeout and the exit words', /class: 'timed_out'/.test(src('src/utils/hooks/engine.ts')) && /class: 'exit'/.test(src('src/utils/hooks/engine.ts')) && src('src/utils/hooks/engine.ts').split('hookEndingSentence(').length === 3)
check('no hand-written ending line remains in the runner or the engine', !/closed stdin before|Error occurred while executing hook|Failed with non-blocking status|timed out after \$\{seconds\}/.test(src('src/utils/hooks/execution.ts') + src('src/utils/hooks/engine.ts')))
if (existsSync(join(ROOT, 'sdk/src/rows.ts'))) check('the SDK vocabulary carries the same row', src('sdk/src/rows.ts').includes('HookEnding'))
else console.log('SKIP the SDK vocabulary row — the SDK is parked and not on this tree (the published lineage carries no sdk/)')
check('the hooks page says the operator sees one line naming the hook, the event and the exit code', src('docs/HOOKS.md').includes('one line naming the hook, the event and the exit code'))

console.log(fail === 0 ? ' ✅ HOOK ENDINGS PASS' : ' ❌ HOOK ENDINGS FAILED')
process.exit(fail)
