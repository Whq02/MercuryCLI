#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { bootRunner, bound, childEnv, DIST, isOutcome, makeTally, MODEL, NODE, SCRATCH_ROOT } from '../daemon/dupline-world.ts'
import { seedScratchHome, startScriptedFixture, type ScriptedRequest } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-background-lifetime-words')
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first`)
  process.exit(0)
}
console.log(`build under proof: ${DIST}`)
const KEEP = process.argv.includes('--keep')
const scratch = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'background-lifetime-')))
console.log(`world: ${scratch}`)

const ASK = 'start the build in the background'
const CHILD_ASK = 'LIFETIME-CREWMATE: start the build in the background'
const FIRST_SENTENCE = /^Running in the background \(ID: b[0-9a-z]+\)\. Output: .+\. Process id \d+\./
const TURN_WORDS = 'This run ends when your turn ends (unless a crewmate is still running) and stops this command then, so its notice reaches you only while you are still working.'
const SESSION_WORDS = 'When it ends, a notice with its exit code reaches you after your next tool result, or in a new turn once yours is over; do not poll it.'
const CREWMATE_WORDS = 'It is stopped when you finish, so its notice reaches you only while you are still working.'
const WAIT_WORDS = /If you need its result, wait for it before you finish: one Bash call with a `timeout` longer than the wait, such as `while kill -0 (\d+) 2>\/dev\/null; do sleep 1; done`\./
const SLEEP_WORDS = 'Sleep runs its full time for a shell command.'
const STOP_WORDS = /TaskStop with task_id "b[0-9a-z]+" ends it\.$/

const launch = (cwd: string): { command: string; run_in_background: boolean; description: string } => ({ command: `sleep 2; echo built > "${join(cwd, 'out.txt')}"`, run_in_background: true, description: 'the build' })
const pidOf = (text: string): number => Number(/Process id (\d+)\./.exec(text)?.[1] ?? Number.NaN)
const startResult = (requests: ScriptedRequest[], ask: string): string | undefined => requests.find(r => r.ask.trim() === ask && r.step === 1)?.results[0]?.text
const noticeOf = (text: string | undefined): string => (text ?? '').split('\n').find(line => line.startsWith('Running in the background')) ?? ''

function oneShot(cwd: string, env: NodeJS.ProcessEnv, prompt: string): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise(resolve => {
    const child = spawn(NODE, [DIST, 'run', prompt, '--format', 'rows', '--mode', 'sovereign', '--model', MODEL], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), bound(120_000))
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, stderr, stdout })
    })
  })
}

tally.section('S4 — a one-prompt run (its input closes at once): the start result names the process and says the run stops the command when the turn ends')
{
  const home = join(scratch, 'turn', 'home')
  const cwd = join(scratch, 'turn', 'work')
  seedScratchHome(home, cwd)
  const fixture = await startScriptedFixture(req => {
    if (req.ask.trim() !== ASK) return [{ type: 'text', text: 'ok' }]
    if (req.step === 0) return [{ type: 'tool_use', name: 'Bash', input: launch(cwd) }]
    return [{ type: 'text', text: 'started' }]
  })
  const port = Number(new URL(fixture.base).port)
  const run = await oneShot(cwd, childEnv(home, port), ASK)
  await fixture.close()
  const text = startResult(fixture.requests, ASK)
  const notice = noticeOf(text)
  tally.check('the one-shot run completed', run.code === 0 && run.stdout.includes('"type":"outcome"'), `exit ${String(run.code)} · ${run.stderr.slice(-300)}`)
  tally.check('the start result keeps the first sentence and adds the process id', FIRST_SENTENCE.test(notice), JSON.stringify(notice.slice(0, 200)))
  tally.check('it says the run ends with the turn and stops the command then', notice.includes(TURN_WORDS), JSON.stringify(notice))
  tally.check('it gives a bounded wait on the process id it named', WAIT_WORDS.test(notice) && Number(WAIT_WORDS.exec(notice)?.[1]) === pidOf(notice), JSON.stringify(notice))
  tally.check('it says Sleep runs its full time for a shell command', notice.includes(SLEEP_WORDS))
  tally.check('it names TaskStop with the task id as the way to end it', STOP_WORDS.test(notice), JSON.stringify(notice.slice(-80)))
  tally.check("it does not carry the open session's words", !notice.includes('in a new turn once yours is over') && !notice.includes(CREWMATE_WORDS))
  tally.check('the result carries the session-env notice on its own line after the start words', (text ?? '').includes('\n[session env scrubbed'), JSON.stringify((text ?? '').slice(-160)))
}

tally.section('S5 — a rows session whose input stays open: the start result says the notice comes after the next tool result or in a new turn')
{
  const home = join(scratch, 'session', 'home')
  const cwd = join(scratch, 'session', 'work')
  seedScratchHome(home, cwd)
  const fixture = await startScriptedFixture(req => {
    if (req.ask.includes('<task-notification>')) return [{ type: 'text', text: 'noted' }]
    if (req.ask.trim() !== ASK) return [{ type: 'text', text: 'ok' }]
    if (req.step === 0) return [{ type: 'tool_use', name: 'Bash', input: launch(cwd) }]
    return [{ type: 'text', text: 'started' }]
  })
  const port = Number(new URL(fixture.base).port)
  const runner = bootRunner({ cwd, env: childEnv(home, port) })
  void runner.prompt(ASK, randomUUID())
  const outcome = await runner.waitFor('the outcome row', isOutcome, bound(90_000))
  await runner.stop(bound(5_000))
  await fixture.close()
  const text = startResult(fixture.requests, ASK)
  const notice = noticeOf(text)
  tally.check('the session turn completed', outcome !== null && outcome.status === 'completed', `${JSON.stringify(outcome).slice(0, 200)} · ${runner.stderr().slice(-300)}`)
  tally.check('the start result keeps the first sentence and adds the process id', FIRST_SENTENCE.test(notice), JSON.stringify(notice.slice(0, 200)))
  tally.check('it says the notice reaches the model after its next tool result or in a new turn', notice.includes(SESSION_WORDS), JSON.stringify(notice))
  tally.check('it names TaskStop with the task id as the way to end it', STOP_WORDS.test(notice), JSON.stringify(notice.slice(-80)))
  tally.check("it does not carry the closed run's words or a wait loop", !notice.includes('This run ends') && !WAIT_WORDS.test(notice) && !notice.includes(SLEEP_WORDS))
}

tally.section("S6 — inside a crewmate: the start result says the command is stopped when the crewmate finishes")
{
  const home = join(scratch, 'crewmate', 'home')
  const cwd = join(scratch, 'crewmate', 'work')
  seedScratchHome(home, cwd)
  mkdirSync(cwd, { recursive: true })
  const fixture = await startScriptedFixture(req => {
    if (req.opening.trim() === CHILD_ASK) {
      if (req.step === 0) return [{ type: 'tool_use', name: 'Bash', input: launch(cwd) }]
      return [{ type: 'text', text: 'CHILD-DONE' }]
    }
    if (req.ask.trim() !== ASK) return [{ type: 'text', text: 'ok' }]
    if (req.step === 0) return [{ type: 'tool_use', name: 'Agent', input: { description: 'the builder', prompt: CHILD_ASK } }]
    return [{ type: 'text', text: 'PARENT-DONE' }]
  })
  const port = Number(new URL(fixture.base).port)
  const run = await oneShot(cwd, childEnv(home, port), ASK)
  await fixture.close()
  const text = startResult(fixture.requests, CHILD_ASK)
  const notice = noticeOf(text)
  tally.check('the run with the crewmate completed', run.code === 0 && run.stdout.includes('"type":"outcome"'), `exit ${String(run.code)} · ${run.stderr.slice(-300)}`)
  tally.check("the crewmate's start result keeps the first sentence and adds the process id", FIRST_SENTENCE.test(notice), JSON.stringify(notice.slice(0, 200)))
  tally.check('it says the command is stopped when the crewmate finishes', notice.includes(CREWMATE_WORDS), JSON.stringify(notice))
  tally.check('it gives a bounded wait on the process id it named', WAIT_WORDS.test(notice) && Number(WAIT_WORDS.exec(notice)?.[1]) === pidOf(notice), JSON.stringify(notice))
  tally.check("it does not carry the run's or the session's words, and no Sleep line", !notice.includes('This run ends') && !notice.includes('in a new turn once yours is over') && !notice.includes(SLEEP_WORDS))
}

if (tally.failed() === 0 && !KEEP) rmSync(scratch, { recursive: true, force: true })
else console.log(`\nworld kept: ${scratch}`)
tally.finish()
