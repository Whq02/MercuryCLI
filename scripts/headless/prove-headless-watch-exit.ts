#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootRunner, bound, childEnv, DIST, isInit, isResult, makeTally, SCRATCH_ROOT, sleep, user } from '../daemon/dupline-world.ts'
import { seedScratchHome, startScriptedFixture } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-headless-watch-exit')
const TIMED = process.argv.includes('--timed')
const KEEP = process.argv.includes('--keep')
const scratch = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'headless-watch-exit-')))
const home = join(scratch, 'home')
const cwd = join(scratch, 'work')
const pidFile = join(scratch, 'watch.pid')
const logFile = join(scratch, 'watched.log')
const ASK = 'arm the fixture watch'
const EXIT_BOUND_MS = 30_000
console.log(`build under proof: ${DIST}`)
console.log(`world: ${scratch}`)
console.log(`watch shape: ${TIMED ? 'timed, thirty minutes' : 'persistent'}`)

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const readPid = (): number | null => {
  if (!existsSync(pidFile)) return null
  const n = Number(readFileSync(pidFile, 'utf8').trim())
  return Number.isFinite(n) && n > 0 ? n : null
}

seedScratchHome(home, cwd)
writeFileSync(logFile, 'first line\n')
const fixture = await startScriptedFixture(req => {
  if (req.ask.trim() !== ASK) return [{ type: 'text', text: 'ok' }]
  if (req.step === 0) {
    const input: Record<string, unknown> = { description: 'the fixture watch', command: `echo $$ > ${pidFile}; exec tail -f ${logFile}` }
    if (TIMED) input.timeout_ms = 1_800_000
    else input.persistent = true
    return [{ type: 'tool_use', name: 'Monitor', input }]
  }
  return [{ type: 'text', text: 'the watch is armed' }]
})
const port = Number(new URL(fixture.base).port)
const runner = bootRunner({ cwd, env: { ...childEnv(home, port), MERCURY_TASKS: '1' } })
runner.send(user(ASK, 'u-arm'))
const init = await runner.waitFor('the session init frame', isInit, bound(90_000))
const result = await runner.waitFor('the result frame', isResult, bound(120_000))
const armed = fixture.requests.find(r => r.ask.trim() === ASK && r.step === 1)
const answer = armed?.results[0]
let pid: number | null = null
for (const until = Date.now() + bound(10_000); pid === null && Date.now() < until; ) {
  pid = readPid()
  if (pid === null) await sleep(100)
}

tally.section('the seat arms a watch, then its input closes')
tally.check('the headless seat booted on the fixture', init !== null, runner.stderr().slice(-400))
tally.check('the Monitor tool answered without an error', answer !== undefined && !answer.isError && /Monitor started/.test(answer.text), answer?.text.slice(0, 300) ?? 'no tool result reached the wire')
tally.check('the turn settled with a result that is not an error', result !== null && result.is_error !== true, JSON.stringify(result).slice(0, 300))
tally.check("the watch's process is running", pid !== null && alive(pid), `pid ${pid ?? 'unknown'}`)

const closedAt = Date.now()
runner.proc.stdin!.end()
const exitCode = await Promise.race([runner.exited, sleep(bound(EXIT_BOUND_MS)).then(() => 'still running' as const)])
const exitedInMs = Date.now() - closedAt
console.log(`\nafter the input closed: ${exitCode === 'still running' ? `the seat is still running after ${exitedInMs} ms` : `the seat exited with ${String(exitCode)} after ${exitedInMs} ms`}`)
await sleep(1_000)
const watchAlive = pid !== null && alive(pid)

tally.section('the seat exits and the watch goes with it')
tally.check(`the seat exited within ${EXIT_BOUND_MS / 1000} s of its input closing`, exitCode !== 'still running', `still running after ${exitedInMs} ms`)
tally.check('the seat exited with the code the turn earned (0)', exitCode === 0, `exit ${String(exitCode)}`)
tally.check("the watch's process is gone once the seat has exited", pid !== null && !watchAlive, `pid ${pid ?? 'unknown'} alive: ${watchAlive}`)

if (exitCode === 'still running') runner.kill()
if (pid !== null && alive(pid)) {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
  }
}
await fixture.close()
if (tally.failed() === 0 && !KEEP) rmSync(scratch, { recursive: true, force: true })
else console.log(`\nworld kept: ${scratch}`)
tally.finish()
