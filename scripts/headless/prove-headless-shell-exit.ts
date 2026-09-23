#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootRunner, bound, childEnv, DIST, isInit, isResult, makeTally, SCRATCH_ROOT, sleep, user, type Frame } from '../daemon/dupline-world.ts'
import { seedScratchHome, startScriptedFixture } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-headless-shell-exit')
const KEEP = process.argv.includes('--keep')
const scratch = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'headless-shell-exit-')))
const ASK = 'start the fixture server'
const EXIT_BOUND_MS = 30_000
const OPEN_INPUT_HOLD_MS = 3_000
const STEP_ONE_DELAY_MS = 1_500
console.log(`build under proof: ${DIST}`)
console.log(`world: ${scratch}`)
console.log('task shape: a background Bash shell that never ends (tail -f, read-only); never a monitor')

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const readPid = (pidFile: string): number | null => {
  if (!existsSync(pidFile)) return null
  const n = Number(readFileSync(pidFile, 'utf8').trim())
  return Number.isFinite(n) && n > 0 ? n : null
}
const isControlResponse = (requestId: string) => (f: Frame): boolean =>
  f.type === 'control_response' && (f.response as { request_id?: unknown } | undefined)?.request_id === requestId

type Close = 'eof-after-result' | 'eof-at-once' | 'end_session'
const legs: Array<{ key: string; close: Close; title: string }> = [
  { key: 's1', close: 'eof-after-result', title: 'S1 — the input closes after the turn (an open input first keeps the shell)' },
  { key: 's2', close: 'eof-at-once', title: 'S2 — the one-shot shape: the input closes as soon as the prompt is sent' },
  { key: 's3', close: 'end_session', title: 'S3 — end_session with the input still open' },
]

for (const leg of legs) {
  const home = join(scratch, leg.key, 'home')
  const cwd = join(scratch, leg.key, 'work')
  const pidFile = join(cwd, 'bg.pid')
  const bgLog = join(cwd, 'bg-server.log')
  seedScratchHome(home, cwd)
  writeFileSync(bgLog, 'server started\n')
  const fixture = await startScriptedFixture(
    req => {
      if (req.ask.trim() !== ASK) return [{ type: 'text', text: 'ok' }]
      if (req.step === 0) {
        return [{ type: 'tool_use', name: 'Bash', input: { description: 'the fixture dev server', command: `echo $$ > "${pidFile}"; exec tail -f "${bgLog}"`, run_in_background: true } }]
      }
      return [{ type: 'text', text: 'the server is started' }]
    },
    { answerDelayMs: req => (req.ask.trim() === ASK && req.step === 1 ? STEP_ONE_DELAY_MS : 0) },
  )
  const port = Number(new URL(fixture.base).port)
  const runner = bootRunner({ cwd, env: { ...childEnv(home, port), MERCURY_TASKS: '1' }, extraArgv: ['--allowed-tools', 'Bash'] })
  runner.send(user(ASK, `u-${leg.key}`))
  const closedAtOnce = leg.close === 'eof-at-once'
  if (closedAtOnce) runner.proc.stdin!.end()
  const init = await runner.waitFor('the session init frame', isInit, bound(90_000))
  let pid: number | null = null
  for (const until = Date.now() + bound(60_000); pid === null && Date.now() < until; ) {
    pid = readPid(pidFile)
    if (pid === null) await sleep(50)
  }
  const ranAlive = pid !== null && alive(pid)
  const result = await runner.waitFor('the result frame', isResult, bound(120_000))
  const armed = fixture.requests.find(r => r.ask.trim() === ASK && r.step === 1)
  const answer = armed?.results[0]

  tally.section(leg.title)
  tally.check('the headless seat booted on the fixture', init !== null, runner.stderr().slice(-400))
  tally.check('the Bash tool started the background shell without an error', answer !== undefined && !answer.isError, answer?.text.slice(0, 300) ?? 'no tool result reached the wire')
  tally.check('the turn settled with a result that is not an error', result !== null && result.is_error !== true, JSON.stringify(result).slice(0, 300))
  tally.check("the background shell's process ran (seen alive before the seat could end it)", ranAlive, `pid ${pid ?? 'unknown'}`)

  let closedAt = Date.now()
  if (leg.close === 'eof-after-result') {
    const heldExit = await Promise.race([runner.exited, sleep(bound(OPEN_INPUT_HOLD_MS)).then(() => 'still running' as const)])
    tally.check(`with the input open the seat waits on its shell (still running ${OPEN_INPUT_HOLD_MS / 1000} s after the result)`, heldExit === 'still running', `exit ${String(heldExit)}`)
    tally.check("with the input open the background shell's process is still running", pid !== null && alive(pid), `pid ${pid ?? 'unknown'}`)
    closedAt = Date.now()
    runner.proc.stdin!.end()
  } else if (leg.close === 'end_session') {
    closedAt = Date.now()
    runner.send({ type: 'control_request', request_id: `end-${leg.key}`, request: { subtype: 'end_session', reason: 'the proof ends the session' } })
    const response = await runner.waitFor('the end_session control response', isControlResponse(`end-${leg.key}`), bound(10_000))
    tally.check('end_session answered with a success control response', response !== null && (response.response as { subtype?: unknown } | undefined)?.subtype === 'success', JSON.stringify(response).slice(0, 300))
  }
  const exitCode = await Promise.race([runner.exited, sleep(bound(EXIT_BOUND_MS)).then(() => 'still running' as const)])
  const exitedInMs = Date.now() - closedAt
  console.log(`\nafter the input closed: ${exitCode === 'still running' ? `the seat is still running after ${exitedInMs} ms` : `the seat exited with ${String(exitCode)} after ${exitedInMs} ms`}`)
  await sleep(1_000)
  const shellAlive = pid !== null && alive(pid)

  tally.check(`the seat exited within ${EXIT_BOUND_MS / 1000} s of its input closing`, exitCode !== 'still running', `still running after ${exitedInMs} ms`)
  tally.check('the seat exited with the code the turn earned (0)', exitCode === 0, `exit ${String(exitCode)}`)
  tally.check("the background shell's process is gone once the seat has exited", pid !== null && !shellAlive, `pid ${pid ?? 'unknown'} alive: ${shellAlive}`)
  if (closedAtOnce) tally.check('the one-shot seat emitted exactly one result', runner.frames.filter(isResult).length === 1, String(runner.frames.filter(isResult).length))

  if (exitCode === 'still running') runner.kill()
  if (pid !== null && alive(pid)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
    }
  }
  await fixture.close()
}

if (tally.failed() === 0 && !KEEP) rmSync(scratch, { recursive: true, force: true })
else console.log(`\nworld kept: ${scratch}`)
tally.finish()
