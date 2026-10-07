import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, NODE, SCRATCH_ROOT, bound, childEnv, makeTally } from '../daemon/dupline-world.ts'
import { frameLines, isOutcome, type Frame } from '../lib/rows.ts'
import { seedScratchHome } from '../lib/scriptedTurn.ts'
import { startOverflowFixture } from '../compact/overflowFixture.ts'

const tally = makeTally('prove-outcome-cost-priced-part')
const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'outcome-cost-priced-part-')))
const home = join(root, 'home')
const cwd = join(root, 'work')
seedScratchHome(home, cwd)
writeFileSync(join(cwd, 'note.txt'), 'a note\n')
const fixture = await startOverflowFixture()
const model = 'openrouter/fixture/model'
const env = { ...childEnv(home, Number(new URL(fixture.base).port)), ...fixture.env, MERCURY_CREDENTIAL_STORE: 'file', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key' }

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
  tally.section('a turn whose first request states its cost on the wire and whose second request does not: the outcome carries the priced part')
  fixture.script([
    { calls: [{ id: 'call_read', name: 'Read', args: JSON.stringify({ file_path: join(cwd, 'note.txt') }) }], usage: { input: 20, output: 5, cost: 0.25 } },
    { text: 'The note says a note.', usage: { input: 30, output: 6 } },
  ])
  const mixed = await run('Read note.txt and tell me what it says.')
  const outcome = mixed.frames.find(isOutcome)
  const models = (outcome?.models ?? {}) as Record<string, { cost_usd?: number }>
  tally.check('the turn completed through two requests', mixed.code === 0 && outcome?.status === 'completed' && fixture.captured.length === 2, JSON.stringify({ code: mixed.code, requests: fixture.captured.length, outcome, stderr: mixed.stderr.slice(-300) }))
  tally.check('the outcome carries cost_usd: the priced request\'s 0.25', typeof outcome?.cost_usd === 'number' && Math.abs(outcome.cost_usd - 0.25) < 1e-9, JSON.stringify(outcome?.cost_usd))
  tally.check('the model with an unpriced request is listed without a cost of its own', Object.keys(models).length === 1 && Object.values(models).every(row => row.cost_usd === undefined), JSON.stringify(models))

  tally.section('a turn with no priced request carries no cost_usd at all: never a $0 that reads as free')
  const before = fixture.captured.length
  fixture.script([{ text: 'Nothing priced here.', usage: { input: 10, output: 3 } }])
  const unpriced = await run('Say something.')
  const bare = unpriced.frames.find(isOutcome)
  tally.check('the unpriced turn completed', unpriced.code === 0 && bare?.status === 'completed' && fixture.captured.length - before === 1, JSON.stringify({ code: unpriced.code, outcome: bare }))
  tally.check('no cost_usd on the outcome and none on the model row', bare !== undefined && !('cost_usd' in bare) && Object.values((bare.models ?? {}) as Record<string, { cost_usd?: number }>).every(row => row.cost_usd === undefined), JSON.stringify({ cost: bare?.cost_usd, models: bare?.models }))
} finally {
  await fixture.close()
  rmSync(root, { recursive: true, force: true })
}
tally.finish()
