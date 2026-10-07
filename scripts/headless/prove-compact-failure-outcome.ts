import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, NODE, SCRATCH_ROOT, bound, childEnv, makeTally } from '../daemon/dupline-world.ts'
import { frameLines, isOutcome, type Frame } from '../lib/rows.ts'
import { seedScratchHome } from '../lib/scriptedTurn.ts'
import { encodeSeedTranscript } from '../lib/seedTranscript.ts'
import { startOverflowFixture } from '../compact/overflowFixture.ts'

const tally = makeTally('prove-compact-failure-outcome')
const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'compact-failure-outcome-')))
const home = join(root, 'home')
const cwd = join(root, 'work')
seedScratchHome(home, cwd)
const fixture = await startOverflowFixture()
const model = 'claude-sonnet-5-5'
const env = { ...childEnv(home, Number(new URL(fixture.base).port)), ...fixture.env, MERCURY_CREDENTIAL_STORE: 'file', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key' }
const id = randomUUID()
const first = randomUUID()
const second = randomUUID()
const seed = join(root, 'synthetic.jsonl')
writeFileSync(seed, encodeSeedTranscript([
  { type: 'user', uuid: first, parentUuid: null, sessionId: id, cwd, timestamp: '2026-10-07T00:00:00.000Z', message: { role: 'user', content: 'Implement a synthetic tags parser and run its tests.' } },
  { type: 'assistant', uuid: second, parentUuid: first, sessionId: id, cwd, timestamp: '2026-10-07T00:00:01.000Z', message: { id: 'msg_synthetic', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'The parser handles quoted commas and deduplicates tags. All 14 tests pass.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 200, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
], id))

function run(ask: string, resume = true): Promise<{ frames: Frame[]; stderr: string; code: number | null }> {
  return new Promise(resolve => {
    const child = spawn(NODE, [DIST, 'run', '--format', 'rows', '--model', model, '--effort', 'max', ...(resume ? ['--resume', seed, '--fork'] : []), ask], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), bound(120_000))
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('close', code => { clearTimeout(timer); resolve({ frames: frameLines(stdout), stderr, code }) })
    child.on('error', error => { clearTimeout(timer); resolve({ frames: frameLines(stdout), stderr: String(error), code: null }) })
  })
}
function failure(label: string, result: Awaited<ReturnType<typeof run>>, words: string): void {
  const outcome = result.frames.find(isOutcome)
  const outputs = result.frames.filter(row => row.type === 'command_output')
  const error = outcome?.error as { message?: string; class?: string } | undefined
  tally.check(`${label}: a failed command exits nonzero`, result.code === 1, JSON.stringify({ code: result.code, stderr: result.stderr }))
  tally.check(`${label}: outcome is failed, never an empty completed answer`, outcome?.status === 'failed' && outcome?.answer === undefined, JSON.stringify(outcome))
  tally.check(`${label}: the error class is command and the original error survives`, error?.class === 'command' && error.message?.includes(words) === true, JSON.stringify(outcome))
  tally.check(`${label}: one command-output row carries the same error`, outputs.length === 1 && outputs[0]?.text === error?.message, JSON.stringify(outputs))
}

try {
  console.log(`build under proof: ${DIST}`)
  fixture.script(() => ({ refusal: true }))
  failure('persistent model refusal', await run('/compact'), 'stop_reason: refusal')
  fixture.script(() => ({ error: { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'synthetic fold request rejected' } } } }))
  failure('non-refusal API failure', await run('/compact'), 'synthetic fold request rejected')
  failure('empty conversation', await run('/compact', false), 'No messages to compact')
  fixture.script(() => ({ text: '<summary>1. Operator Intent: build the synthetic tags parser.\n8. Where Work Stands: all 14 tests pass.\n10. Agents in flight: none.</summary>' }))
  const success = await run('/compact')
  const outcome = success.frames.find(isOutcome)
  tally.check('a successful fold still completes with exit 0 and its receipt', success.code === 0 && outcome?.status === 'completed' && String(outcome.answer).startsWith('Compacted'), JSON.stringify(outcome))
  tally.check('a successful fold has no error field', outcome?.error === undefined, JSON.stringify(outcome))
  tally.check('a successful fold announces its own output once', success.frames.filter(row => row.type === 'command_output').length === 1)
} finally {
  await fixture.close()
  rmSync(root, { recursive: true, force: true })
}
tally.finish()
