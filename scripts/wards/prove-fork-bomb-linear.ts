import { spawnSync } from 'node:child_process'
import { REFUSAL_WARDS, evaluateWards, buildWardDenial } from '../../src/utils/wards/wards.ts'
import { makeTally } from '../daemon/dupline-world.ts'

const rule = REFUSAL_WARDS.find(rule => rule.name === 'no-fork-bomb')!
const verdict = (command: string) => evaluateWards([rule], { toolName: 'Bash', input: { command }, shellCommand: command })
if (process.argv.includes('--child')) {
  const started = performance.now()
  const name = 'a'.repeat(300_000)
  for (const command of [name + '!', `function ${name}!`, `${name} (){ ${name}|other&`]) {
    if (!verdict(command).allow) throw new Error('benign near-match refused')
  }
  console.log(JSON.stringify({ elapsedMs: performance.now() - started }))
} else {
  const tally = makeTally('prove-fork-bomb-linear')
  const result = spawnSync(process.execPath, [import.meta.filename, '--child'], { encoding: 'utf8', timeout: 3000 })
  const timing = result.status === 0 ? JSON.parse(result.stdout) : null
  console.log(JSON.stringify({ code: result.status, signal: result.signal, timing }))
  tally.check('long near-matches finish rather than stall', result.status === 0, String(result.error ?? result.stderr))
  tally.check('the checks take milliseconds', timing !== null && timing.elapsedMs < 250)
  for (const command of [':(){ :|:& };:', 'f(){ f|f& };f', 'function fork { fork | fork & }; fork', 'fork while fork', 'echo ok; f () { f | f & }; f', 'x=1\nf() { f | f & };f']) {
    const got = verdict(command)
    tally.check('fork-bomb form stays refused', !got.allow, command)
    if (!got.allow) tally.check('the existing refusal words survive', buildWardDenial(got, 'Bash').includes('A process that forks itself without bound takes the machine down.'))
  }
  for (const command of ['function normal { echo ok; }', 'f(){ other|other& }; f', 'printf hello']) tally.check('ordinary shell text stays allowed', verdict(command).allow, command)
  tally.finish()
}
