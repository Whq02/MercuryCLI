import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, NODE, SCRATCH_ROOT, bound, childEnv, makeTally } from '../daemon/dupline-world.ts'
import { frameLines, isOutcome, type Frame } from '../lib/rows.ts'
import { seedScratchHome } from '../lib/scriptedTurn.ts'
import { encodeSeedTranscript } from '../lib/seedTranscript.ts'
import { startOverflowFixture } from '../compact/overflowFixture.ts'

const tally = makeTally('prove-compact-refusal-resume')
const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'compact-refusal-resume-')))
const home = join(root, 'home')
const cwd = join(root, 'work')
seedScratchHome(home, cwd)
const fixture = await startOverflowFixture()
const model = 'claude-sonnet-5-5'
const env = { ...childEnv(home, Number(new URL(fixture.base).port)), ...fixture.env, MERCURY_CREDENTIAL_STORE: 'file', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key' }
const id = randomUUID()
const seed = join(root, 'synthetic.jsonl')
const history: Array<Record<string, unknown>> = []
let parent: string | null = null
for (let index = 0; index < 12; index++) {
  const user = randomUUID()
  const assistant = randomUUID()
  history.push({ type: 'user', uuid: user, parentUuid: parent, sessionId: id, cwd, timestamp: '2026-10-07T00:00:00.000Z', message: { role: 'user', content: `Implement module ${index} and run its tests.` } })
  history.push({ type: 'assistant', uuid: assistant, parentUuid: user, sessionId: id, cwd, timestamp: '2026-10-07T00:00:01.000Z', message: { id: `msg_${index}`, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: `Observed result ${index}: ${index === 0 ? 'FIRST_SENTINEL_14_TESTS' : `RECENT_SENTINEL_${index}`} ${'The synthetic verification log has facts to retain. '.repeat(200)}` }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 20000, output_tokens: 2400, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })
  parent = assistant
}
writeFileSync(seed, encodeSeedTranscript(history as never, id))

function run(ask: string, resume = seed): Promise<{ frames: Frame[]; stderr: string; code: number | null }> {
  return new Promise(resolve => {
    const child = spawn(NODE, [DIST, 'run', '--format', 'rows', '--model', model, '--effort', 'max', '--resume', resume, '--fork', ask], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
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
  const refusal = 'I cannot summarize this conversation. I refuse to provide the requested summary. No summary will be provided.'
  const skippedLine = `The prose summary was skipped: the answer refused in prose: ${JSON.stringify(refusal)}.`
  const withoutCause = (text: string): string => text.split(JSON.stringify(skippedLine).slice(1, -1)).join('').split(skippedLine).join('')
  fixture.script(() => ({ text: refusal }))
  const folded = await run('/compact')
  const outcome = folded.frames.find(isOutcome)
  const output = folded.frames.filter(row => row.type === 'command_output')
  tally.check('prose refusal: /compact lands on the records and exits 0 (the owner\'s ruling for 1.0.0-beta.38: a conversation can always be compacted; red on the base: exit 1, "Failed to generate a conversation summary.")', folded.code === 0 && outcome?.status === 'completed' && outcome.error === undefined, JSON.stringify({ code: folded.code, outcome, stderr: folded.stderr }))
  tally.check('prose refusal: the receipt is the Compacted line and the one line naming why the prose was skipped', String(outcome?.answer ?? '').startsWith('Compacted') && String(outcome?.answer ?? '').includes(skippedLine), JSON.stringify(outcome?.answer))
  tally.check('prose refusal: one output row owns the same receipt', output.length === 1 && output[0]?.text === outcome?.answer, JSON.stringify(output))
  tally.check('prose refusal: the answer, then the two halved retries with thinking off, and no more', fixture.captured.length === 3, String(fixture.captured.length))
  const resumedId = typeof outcome?.session_id === 'string' ? outcome.session_id : 'missing-outcome-session'
  fixture.script(() => ({ text: 'A post-fold reply. The original facts remain available.' }))
  const before = fixture.captured.length
  const resumed = await run('Continue with the pending checks.', resumedId)
  const wire = JSON.stringify(fixture.captured.slice(before).map(request => request.body.messages))
  tally.check('resume: the next prompt is answered', resumed.code === 0 && resumed.frames.find(isOutcome)?.status === 'completed', JSON.stringify({ code: resumed.code, stderr: resumed.stderr }))
  tally.check('resume: the refusal is never the summary — it rides only inside the one line that names the cause; the folded stretch left the wire with its oldest fact', !withoutCause(wire).includes(refusal) && wire.includes(JSON.stringify(skippedLine).slice(1, -1)) && !wire.includes('FIRST_SENTINEL_14_TESTS'), JSON.stringify({ refusalOutsideTheCause: withoutCause(wire).includes(refusal), causeLine: wire.includes(JSON.stringify(skippedLine).slice(1, -1)), oldestFact: wire.includes('FIRST_SENTINEL_14_TESTS') }))
  tally.check('resume: the recent tail remains available', wire.includes('RECENT_SENTINEL_11'))
  const work = async (from: string, label: string): Promise<string> => {
    let id = from
    for (let step = 1; step <= 12; step++) {
      fixture.script(() => ({ text: `${label} step ${step}: ${Array.from({ length: 160 }, (_, n) => `fact ${step}-${n} of the verification log reads ${(n * 7919 + step * 104729).toString(36)}.`).join(' ')}` }))
      const turn = await run(`${label}: carry step ${step}`, id)
      const turnOutcome = turn.frames.find(isOutcome)
      if (turn.code !== 0 || typeof turnOutcome?.session_id !== 'string') throw new Error(`${label} step ${step} did not settle: ${JSON.stringify({ code: turn.code, stderr: turn.stderr.slice(-300) })}`)
      id = turnOutcome.session_id
    }
    return id
  }
  const refoldStraightAfter = await run('/compact', resumedId)
  const refoldOutcome = refoldStraightAfter.frames.find(isOutcome)
  tally.check('a /compact straight after the fold, with nothing new to fold, is refused in one line and asks the summariser nothing', refoldStraightAfter.code === 1 && refoldOutcome?.status === 'failed' && /Nothing to compact: the last fold already holds this conversation \(\d+(\.\d+)?k? tokens\)$/.test(String(refoldOutcome?.error?.message ?? '')), JSON.stringify(refoldOutcome).slice(0, 300))
  const workedId = await work(resumedId, 'first stretch')
  const firstSummary = 'The synthetic modules are implemented. FIRST_SENTINEL_14_TESTS records the earlier result; RECENT_SENTINEL_11 is the recent result. Continue with the pending checks.'
  fixture.script(() => ({ text: `<summary>${firstSummary}</summary>` }))
  const recovered = await run('/compact', workedId)
  const recoveredOutcome = recovered.frames.find(isOutcome)
  tally.check('recovery: a new fold can land after the refusal once there is work to fold', recovered.code === 0 && recoveredOutcome?.status === 'completed', JSON.stringify({ code: recovered.code, outcome: recoveredOutcome }))
  const firstFoldId = typeof recoveredOutcome?.session_id === 'string' ? recoveredOutcome.session_id : 'missing-first-fold-session'
  const workedAgainId = await work(firstFoldId, 'second stretch')
  const beforeSecond = fixture.captured.length
  const secondSummary = 'The pending checks are ready. The earlier parser result is FIRST_SENTINEL_14_TESTS, and the recent result is RECENT_SENTINEL_11. Resume CLI verification.'
  fixture.script(() => ({ text: `<summary>${secondSummary}</summary>` }))
  const secondFold = await run('/compact', workedAgainId)
  const secondOutcome = secondFold.frames.find(isOutcome)
  const secondWire = JSON.stringify(fixture.captured.slice(beforeSecond).map(request => request.body.messages))
  tally.check('second fold: the first summary is input to a successful new fold', secondFold.code === 0 && secondOutcome?.status === 'completed' && secondWire.includes(firstSummary), JSON.stringify({ code: secondFold.code, outcome: secondOutcome, carriesFirstSummary: secondWire.includes(firstSummary) }))
  const secondId = typeof secondOutcome?.session_id === 'string' ? secondOutcome.session_id : 'missing-second-fold-session'
  const beforeFinal = fixture.captured.length
  fixture.script(() => ({ text: 'The session continues after both folds.' }))
  const final = await run('Continue with CLI verification.', secondId)
  const finalWire = JSON.stringify(fixture.captured.slice(beforeFinal).map(request => request.body.messages))
  tally.check('second resume: the new summary replaces rather than duplicates the first', final.code === 0 && finalWire.includes(secondSummary) && !finalWire.includes(firstSummary), JSON.stringify({ code: final.code, first: finalWire.includes(firstSummary), second: finalWire.includes(secondSummary) }))
} finally {
  await fixture.close()
  rmSync(root, { recursive: true, force: true })
}
tally.finish()
