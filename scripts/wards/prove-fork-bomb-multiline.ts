import { spawnSync } from 'node:child_process'
import { REFUSAL_WARDS, evaluateWards, buildWardDenial } from '../../src/utils/wards/wards.ts'
import { makeTally } from '../daemon/dupline-world.ts'

const rule = REFUSAL_WARDS.find(rule => rule.name === 'no-fork-bomb')!
const verdict = (command: string) => evaluateWards([rule], { toolName: 'Bash', input: { command }, shellCommand: command })
if (process.argv.includes('--child')) {
  const started = performance.now()
  const name = 'a'.repeat(300_000)
  for (const command of [name + '!\n', `function\n${name}!`, `${name} (){\n${name}|other&`, 'f(){\n' + ' '.repeat(300_000) + 'f|other&']) {
    if (!verdict(command).allow) throw new Error('benign near-match refused')
  }
  console.log(JSON.stringify({ elapsedMs: performance.now() - started }))
} else {
  const tally = makeTally('prove-fork-bomb-multiline')
  for (const command of [':(){\n :|:&\n};:', 'f(){\n f|f&\n};f', 'function fork {\n fork |\n fork &\n}; fork', 'fork\nwhile\nfork', 'f ()\n{\n f | f &\n}; f']) {
    const got = verdict(command)
    tally.check('a body split across physical lines is refused', !got.allow)
    if (!got.allow) tally.check('the refusal keeps its existing sentence', buildWardDenial(got, 'Bash').includes('A process that forks itself without bound takes the machine down.'))
  }
  const located = verdict('printf okay\nf() {\n f | f &\n}; f')
  tally.check('the refusal points at the function definition line', !located.allow && located.line === 2)
  for (const command of ['f(){ f|f& };f', ':(){ :|:& };:']) tally.check('single-line forms remain refused', !verdict(command).allow)
  for (const command of ['f(){\n other|other&\n};f', 'function normal {\n echo ok;\n}', 'printf okay\nprintf done']) tally.check('ordinary multiline commands stay allowed', verdict(command).allow)
  const result = spawnSync(process.execPath, [import.meta.filename, '--child'], { encoding: 'utf8', timeout: 3000 })
  const timing = result.status === 0 ? JSON.parse(result.stdout) : null
  console.log(JSON.stringify({ code: result.status, signal: result.signal, timing }))
  tally.check('long multiline near-matches settle in milliseconds', result.status === 0 && timing.elapsedMs < 250, String(result.error ?? result.stderr))
  tally.finish()
}
