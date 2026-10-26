import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, NODE, SCRATCH_ROOT, bound, childEnv, makeTally } from '../daemon/dupline-world.ts'
import { frameLines, isOutcome, isToolCall, isToolResult, type Frame } from '../lib/rows.ts'
import { seedScratchHome } from '../lib/scriptedTurn.ts'
import { startOverflowFixture } from '../compact/overflowFixture.ts'

const tally = makeTally('prove-refused-call-rows')
const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'refused-call-rows-')))
const home = join(root, 'home')
const cwd = join(root, 'work')
seedScratchHome(home, cwd)
const fixture = await startOverflowFixture()
const model = 'openrouter/fixture/model'
const env = { ...childEnv(home, Number(new URL(fixture.base).port)), ...fixture.env, MERCURY_CREDENTIAL_STORE: 'file', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key' }
const malformedGitArgs = { plan: { groups: [{ files: ['README.md'], message: 'init' }] } }

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
  tally.section('a schema-refused call rides as one tool_call and one error tool_result, joined by the call id')
  fixture.script([{ calls: [{ id: 'call_refused_1', name: 'Git', args: JSON.stringify(malformedGitArgs) }] }, { text: 'Corrected: nothing to commit.' }])
  const run1 = await run('Commit the README.')
  const outcome = run1.frames.find(isOutcome)
  const notices = run1.frames.filter(row => row.type === 'notice').map(row => String(row.text ?? ''))
  const call = run1.frames.find(row => isToolCall(row) && row.call_id === 'call_refused_1')
  const result = run1.frames.find(row => isToolResult(row) && row.call_id === 'call_refused_1')
  tally.check('the error result replaces the detached correction notice and the corrected turn completes', run1.code === 0 && outcome?.status === 'completed' && outcome.answer === 'Corrected: nothing to commit.' && !notices.some(text => text.includes('Tool call refused before execution (Git)')), JSON.stringify({ code: run1.code, outcome, notices, stderr: run1.stderr.slice(-300) }))
  tally.check('a tool_call row carries the refused call id, the tool and the arguments as delivered', call !== undefined && call.tool === 'Git' && JSON.stringify(call.input) === JSON.stringify(malformedGitArgs) && typeof call.message_id === 'string' && typeof call.block === 'number', JSON.stringify(call))
  tally.check('one error tool_result joins the call and carries its schema correction', run1.frames.filter(row => isToolResult(row) && row.call_id === 'call_refused_1').length === 1 && result?.status === 'error' && typeof result.output === 'string' && result.output.includes('Git failed') && result.output.includes('The parameter `plan` was not expected') && result.output.includes('The call did not run.'), JSON.stringify(result))
  const callSeq = Number(call?.seq ?? -1)
  const resultSeq = Number(result?.seq ?? -1)
  const outcomeSeq = Number(outcome?.seq ?? -1)
  tally.check('the pair lands in order before the corrected outcome', callSeq > 0 && resultSeq > callSeq && outcomeSeq > resultSeq, JSON.stringify({ callSeq, resultSeq, outcomeSeq }))
  tally.check('the refused call is not a denial: the outcome lists none', Array.isArray(outcome?.denials) && (outcome!.denials as unknown[]).length === 0, JSON.stringify(outcome?.denials))
} finally {
  await fixture.close()
  rmSync(root, { recursive: true, force: true })
}
tally.finish()
