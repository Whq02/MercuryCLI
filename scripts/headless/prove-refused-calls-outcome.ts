import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, NODE, SCRATCH_ROOT, bound, childEnv, makeTally } from '../daemon/dupline-world.ts'
import { frameLines, isOutcome, type Frame } from '../lib/rows.ts'
import { seedScratchHome } from '../lib/scriptedTurn.ts'
import { startOverflowFixture } from '../compact/overflowFixture.ts'

const tally = makeTally('prove-refused-calls-outcome')
const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'refused-calls-outcome-')))
const home = join(root, 'home')
const cwd = join(root, 'work')
seedScratchHome(home, cwd)
const fixture = await startOverflowFixture()
const model = 'openrouter/fixture/model'
const env = { ...childEnv(home, Number(new URL(fixture.base).port)), ...fixture.env, MERCURY_CREDENTIAL_STORE: 'file', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key' }
const malformedGitCall = (n: number) => ({ calls: [{ id: `call_${n}`, name: 'Git', args: JSON.stringify({ plan: { groups: [{ files: ['README.md'], message: 'init' }] } }) }] })

function run(ask: string): Promise<{ frames: Frame[]; stderr: string; code: number | null }> {
  return new Promise(resolve => {
    const child = spawn(NODE, [DIST, 'run', '--format', 'rows', '--model', model, ask], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), bound(120_000))
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('close', code => { clearTimeout(timer); resolve({ frames: frameLines(stdout), stderr, code }) })
    child.on('error', error => { clearTimeout(timer); resolve({ frames: frameLines(stdout), stderr: String(error), code: null }) })
  })
}

try {
  console.log(`build under proof: ${DIST}`)
  tally.section('four malformed Git calls in a row: the correction budget is spent and the run has no answer')
  fixture.script(request => malformedGitCall(fixture.captured.indexOf(request) + 1))
  const spent = await run('Commit the README.')
  const outcome = spent.frames.find(isOutcome)
  const error = outcome?.error as { message?: string; class?: string } | undefined
  const notices = spent.frames.filter(row => row.type === 'notice').map(row => String(row.text ?? ''))
  tally.check('the model was asked four times: the first call and three corrections', fixture.captured.length === 4, String(fixture.captured.length))
  tally.check('three correction notices count 1/3, 2/3, 3/3', ['1/3', '2/3', '3/3'].every(mark => notices.some(text => text.includes('Tool call refused before execution (Git)') && text.includes(mark))), JSON.stringify(notices))
  tally.check('the outcome is failed, never completed', outcome?.status === 'failed', JSON.stringify(outcome))
  tally.check('the refusal note is not the answer', outcome?.answer === undefined, JSON.stringify(outcome?.answer))
  tally.check('the error sentence names the tool and the spent corrections', error?.class === 'model' && error.message?.includes('Git') === true && error.message.includes('refused before execution') && error.message.includes('3 corrections'), JSON.stringify(error))
  tally.check('a notice says the turn ends without an answer', notices.some(text => text.includes('could not') && text.includes('ends without an answer')), JSON.stringify(notices))
  tally.check('the headless exit follows the failure: non-zero', spent.code === 1, JSON.stringify({ code: spent.code, stderr: spent.stderr.slice(-400) }))

  tally.section('one malformed call then a corrected answer: the correction road still completes')
  const before = fixture.captured.length
  fixture.script([malformedGitCall(1), { text: 'The README is committed.' }])
  const recovered = await run('Commit the README.')
  const good = recovered.frames.find(isOutcome)
  tally.check('two requests: the call and its correction', fixture.captured.length - before === 2, String(fixture.captured.length - before))
  tally.check('the corrected turn completes with the answer and exit 0', recovered.code === 0 && good?.status === 'completed' && good.answer === 'The README is committed.', JSON.stringify({ code: recovered.code, outcome: good }))
} finally {
  await fixture.close()
  rmSync(root, { recursive: true, force: true })
}
tally.finish()
