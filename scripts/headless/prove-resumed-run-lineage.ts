import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, NODE, SCRATCH_ROOT, bound, childEnv, makeTally } from '../daemon/dupline-world.ts'
import { frameLines, isOutcome, isSession, type Frame } from '../lib/rows.ts'
import { seedScratchHome } from '../lib/scriptedTurn.ts'
import { startOverflowFixture } from '../compact/overflowFixture.ts'

const tally = makeTally('prove-resumed-run-lineage')
const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'resumed-run-lineage-')))
const home = join(root, 'home')
const cwd = join(root, 'work')
seedScratchHome(home, cwd)
const fixture = await startOverflowFixture()
const model = 'openrouter/fixture/model'
const env = { ...childEnv(home, Number(new URL(fixture.base).port)), ...fixture.env, MERCURY_CREDENTIAL_STORE: 'file', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key' }

function run(args: string[]): Promise<{ frames: Frame[]; stderr: string; code: number | null }> {
  return new Promise(resolve => {
    const child = spawn(NODE, [DIST, 'run', '--format', 'rows', '--model', model, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
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
  tally.section('a fresh run: the session row carries no lineage')
  fixture.script([{ text: 'First answer.' }])
  const first = await run(['Say the first answer.'])
  const firstSession = first.frames.find(isSession)
  const firstOutcome = first.frames.find(isOutcome)
  const firstId = String(firstSession?.session_id ?? '')
  tally.check('the first run completed', first.code === 0 && firstOutcome?.status === 'completed', JSON.stringify({ code: first.code, outcome: firstOutcome, stderr: first.stderr.slice(-300) }))
  tally.check('a fresh run carries no resume_of', firstSession !== undefined && !('resume_of' in firstSession), JSON.stringify(firstSession?.resume_of))

  tally.section('the run continued with -c: a new stream, seq from 1, whose session row names the conversation it continues')
  fixture.script([{ text: 'Second answer.' }])
  const second = await run(['-c', 'Say the second answer.'])
  const secondSession = second.frames.find(isSession)
  const secondOutcome = second.frames.find(isOutcome)
  tally.check('the continued run completed', second.code === 0 && secondOutcome?.status === 'completed', JSON.stringify({ code: second.code, outcome: secondOutcome, stderr: second.stderr.slice(-300) }))
  tally.check('the continued run keeps the conversation\'s session id', secondSession?.session_id === firstId && firstId !== '', JSON.stringify({ first: firstId, second: secondSession?.session_id }))
  tally.check('its session row carries resume_of naming the first run\'s session', secondSession?.resume_of === firstId, JSON.stringify({ resume_of: secondSession?.resume_of, firstId }))
  tally.check('its sequence starts again at 1 (the lineage field, not a continued sequence, joins the two streams)', secondSession?.seq === 1, JSON.stringify(secondSession?.seq))
  tally.check('its turn numbering starts again at 1', secondOutcome?.turn === 1, JSON.stringify(secondOutcome?.turn))
} finally {
  await fixture.close()
  rmSync(root, { recursive: true, force: true })
}
tally.finish()
