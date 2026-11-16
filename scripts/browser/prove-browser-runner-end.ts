#!/usr/bin/env bun
import { spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { RUNNER_ASK_BOUND_MS, TaskRoster } from '../../src/daemon/roster.ts'
import { hostRunner } from '../lib/runnerHost.ts'
import { childEnv, scratchWorld, seedScratchHome, startScriptedFixture } from '../lib/scratchSeat.ts'
import { describeSeat, seatRuntime } from '../lib/seatLauncher.ts'
import { check, finish, requireBrowser, section } from './harness.ts'

await requireBrowser()

const ASK = 'runner-end: open the blank tab'
const LANDED = 'runner-end: the blank tab is open'
const nap = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))
interface Ended {
  ms: number
  code: number | null
  signal: NodeJS.Signals | null
}
const endOf = (child: ChildProcess, began: number): Promise<Ended> => new Promise(resolve => child.once('exit', (code, signal) => resolve({ ms: Date.now() - began, code, signal })))
const lapse = (ms: number): Promise<null> => new Promise(resolve => setTimeout(() => resolve(null), ms))
const words = (ended: Ended | null): string => (ended === null ? 'it still stands' : `it ended after ${ended.ms} ms with ${ended.signal === null ? `exit code ${ended.code}` : `signal ${ended.signal}`}`)

section('S1 a real runner whose browser stands on a temporary profile, asked to end by the roster')
{
  const { runHome, cwd } = scratchWorld('runner-end')
  seedScratchHome(runHome, cwd)
  const temp = join(runHome, '..', 'temp')
  mkdirSync(temp, { recursive: true })
  let turnOver = false
  const fixture = await startScriptedFixture(req => (req.ask.trim() === ASK && req.step === 0 ? [{ type: 'tool_use', name: 'Browser', input: { op: 'open', tab: 'blank' } }] : [{ type: 'text', text: LANDED }]), { answerDelayMs: () => (turnOver ? RUNNER_ASK_BOUND_MS + 2000 : 0) })
  const seat = seatRuntime(join(runHome, '..'))
  console.log(`    the runner: ${describeSeat(seat)}`)
  const runner = hostRunner({
    node: seat.exe,
    dist: seat.script,
    home: runHome,
    cwd,
    argv: ['--session-id', randomUUID()],
    env: { ...(childEnv(runHome, Number(new URL(fixture.base).port)) as Record<string, string | undefined>), HOME: runHome, MERCURY_CONCOURSE_WORKER: '1', MERCURY_SESSION_KIND: 'oculus', TMPDIR: temp, TMP: temp, TEMP: temp },
  })
  runner.onAsk(params => (params.kind === 'tool' ? { outcome: 'allow', input: params.input } : { outcome: 'allow' }))
  const profiles = (): string[] => readdirSync(temp).filter(name => /^puppeteer_dev_[a-z]+_profile-/.test(name))
  let opened = ''
  try {
    await runner.initialize()
    await runner.prompt(ASK)
    const outcome = await runner.waitFor('the turn that opens the blank tab', row => row.type === 'outcome', 120_000)
    opened = `the turn ended ${String(outcome.status)}`
  } catch (error) {
    opened = String(error).slice(0, 300)
  }
  turnOver = true
  const asked = fixture.requests.length + fixture.asks.length
  const before = profiles()
  check('after its turn opened the blank tab the runner holds one temporary profile folder', before.length === 1, `${opened}; ${before.length} folders under the runner’s temp folder; ${runner.stderr().slice(-300)}`)
  const folder = before[0] === undefined ? '' : join(temp, before[0])
  const roster = new TaskRoster({ platform: 'win32' } as never)
  ;(roster as unknown as { handles: Map<string, unknown> }).handles.set('held', {
    entry: { short: 'held', state: 'running' },
    child: runner.child,
    done: Promise.resolve(),
    longLived: { spec: {}, intentionalStop: false, turnEdges: 0, spawnGeneration: 1, turnActive: false, waitingOnAgents: 0 },
  })
  const began = Date.now()
  const ending = endOf(runner.child, began)
  const said = roster.kill('held')
  const returned = Date.now() - began
  check('the roster’s kill answers at once, with the runner’s input ended and no strike', said === true && returned < 250 && runner.child.stdin?.writableEnded === true && runner.child.exitCode === null && runner.child.signalCode === null, `answered ${said} in ${returned} ms; input ended ${runner.child.stdin?.writableEnded}`)
  const ended = await Promise.race([ending, lapse(RUNNER_ASK_BOUND_MS + 4000)])
  check(`the runner ends itself well within the ${RUNNER_ASK_BOUND_MS / 1000} s bound: an exit code, no signal`, ended !== null && ended.signal === null && ended.ms < RUNNER_ASK_BOUND_MS - 1000, words(ended))
  check('on its way out it asks the model nothing: the note for the next session is its host’s to ask for', fixture.requests.length + fixture.asks.length === asked, `${fixture.requests.length + fixture.asks.length - asked} request(s) after the turn, ${fixture.asks.length} of them for the note, to a model made to answer in ${(RUNNER_ASK_BOUND_MS + 2000) / 1000} s`)
  for (let waited = 0; waited < 20 && folder !== '' && existsSync(folder); waited++) await nap(50)
  check('its temporary profile folder is gone', folder !== '' && !existsSync(folder), folder === '' ? 'there was no folder to read' : existsSync(folder) ? `${folder} still stands with ${readdirSync(folder).length} entries at its top` : '')
  if (process.platform === 'win32') console.log('  [SKIP] no browser process is left on that profile — not read on win32: a folder a browser still holds cannot be removed there, so the check before this one stands for it')
  else {
    const left = folder === '' ? ['not read'] : String(spawnSync('ps', ['-A', '-ww', '-o', 'pid=,command=']).stdout).split('\n').filter(line => line.includes(`--user-data-dir=${folder}`))
    check('no browser process is left on that profile', left.length === 0, left.slice(0, 2).join(' | ').slice(0, 300))
  }
  const waited = Date.now()
  await roster.askedSettled()
  check('and the roster holds no runner as still ending', Date.now() - waited < 250, `${Date.now() - waited} ms`)
  if (ended === null) runner.child.kill('SIGKILL')
  console.log(`    the kill answered in ${returned} ms; ${words(ended)}`)
  await fixture.close()
}

await finish('prove-browser-runner-end', [])
