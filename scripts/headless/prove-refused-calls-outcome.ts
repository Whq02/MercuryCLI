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
  tally.section('three identical schema-refused Git calls end through the failed-call loop guard without an answer')
  let calls = 0
  fixture.script(() => malformedGitCall(++calls))
  const spent = await run('Commit the README.')
  const outcome = spent.frames.find(isOutcome)
  const error = outcome?.error as { message?: string; class?: string } | undefined
  const notices = spent.frames.filter(row => row.type === 'notice').map(row => String(row.text ?? ''))
  tally.check('the model was asked three times before the identical-failure stop', fixture.captured.length === 3, String(fixture.captured.length))
  const results = spent.frames.filter(row => row.type === 'tool_result')
  tally.check('all three refused calls receive their own schema error result', results.length === 3 && results.every((row, index) => row.call_id === `call_${index + 1}` && row.status === 'error' && String(row.output).includes('The parameter `plan` was not expected') && String(row.output).includes('The call did not run.')), JSON.stringify(results))
  tally.check('the outcome is loop_stopped, never completed', outcome?.status === 'loop_stopped', JSON.stringify(outcome))
  tally.check('the refusal note is not the answer', outcome?.answer === undefined, JSON.stringify(outcome?.answer))
  tally.check('the error names the tool, the three failures and the schema correction', error?.class === 'loop_stopped' && error.message?.startsWith('Stopped after 3 failed Git calls with the same arguments') === true && error.message.includes('The parameter `plan` was not expected'), JSON.stringify(error))
  tally.check('the second failure prompts a correction and the third reports the stop', notices.length === 2 && notices[0]?.startsWith('Loop check: Git failed again with the same arguments') === true && notices[1] === error?.message, JSON.stringify(notices))
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
