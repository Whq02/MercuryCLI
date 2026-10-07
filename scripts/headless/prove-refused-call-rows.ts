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
  tally.section('a call refused before execution rides as a tool_call row and a tool_result row with status refused, joined by the call id')
  fixture.script([{ calls: [{ id: 'call_refused_1', name: 'Git', args: JSON.stringify(malformedGitArgs) }] }, { text: 'Corrected: nothing to commit.' }])
  const run1 = await run('Commit the README.')
  const outcome = run1.frames.find(isOutcome)
  const notices = run1.frames.filter(row => row.type === 'notice').map(row => String(row.text ?? ''))
  const call = run1.frames.find(row => isToolCall(row) && row.call_id === 'call_refused_1')
  const result = run1.frames.find(row => isToolResult(row) && row.call_id === 'call_refused_1')
  tally.check('the refusal notice was written and the corrected turn completed', run1.code === 0 && outcome?.status === 'completed' && notices.some(text => text.includes('Tool call refused before execution (Git)')), JSON.stringify({ code: run1.code, outcome, notices, stderr: run1.stderr.slice(-300) }))
  tally.check('a tool_call row carries the refused call id, the tool and the arguments as delivered', call !== undefined && call.tool === 'Git' && JSON.stringify(call.input) === JSON.stringify(malformedGitArgs) && typeof call.message_id === 'string' && typeof call.block === 'number', JSON.stringify(call))
  tally.check('a tool_result row with status refused joins it and carries the reason', result !== undefined && result.status === 'refused' && typeof result.output === 'string' && result.output.length > 0, JSON.stringify(result))
  const callSeq = Number(call?.seq ?? -1)
  const resultSeq = Number(result?.seq ?? -1)
  const noticeSeq = Number(run1.frames.find(row => row.type === 'notice')?.seq ?? -1)
  tally.check('the pair lands in order, before the correction notice', callSeq > 0 && resultSeq > callSeq && noticeSeq > resultSeq, JSON.stringify({ callSeq, resultSeq, noticeSeq }))
  tally.check('the refused call is not a denial: the outcome lists none', Array.isArray(outcome?.denials) && (outcome!.denials as unknown[]).length === 0, JSON.stringify(outcome?.denials))
} finally {
  await fixture.close()
  rmSync(root, { recursive: true, force: true })
}
tally.finish()
