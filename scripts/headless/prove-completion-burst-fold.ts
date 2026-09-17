#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIST, MODEL, NODE, childEnv, makeTally, sleep } from '../daemon/dupline-world.ts'
import { seedScratchHome, startScriptedFixture, type ScriptedFixture, type WireBlock } from '../lib/scriptedTurn.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { POLL_INTERVAL_MS } from '../../src/utils/task/framework.ts'

const tally = makeTally('prove-completion-burst-fold')
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first`)
  process.exit(0)
}
console.log(`build under proof: ${DIST}`)

const NOTIFICATION = '<task-notification>'
const LAUNCH_ASK = 'burst: launch the background commands'
const LAUNCHED = 'burst: launched'
const NOTED = 'burst: noted'

type Frame = Record<string, unknown> & { atMs: number }
type Runner = { frames: Frame[]; send: (frame: Record<string, unknown>) => void; stop: (graceMs: number) => Promise<void>; stderr: () => string }

function boot(cwd: string, env: NodeJS.ProcessEnv): Runner {
  const argv = [DIST, '-p', '--input-format=stream-json', '--output-format=stream-json', '--model', MODEL, '--permission-mode', 'bypassPermissions', '--allowed-tools', 'Bash']
  const proc = spawn(NODE, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const frames: Frame[] = []
  let buffer = ''
  let stderr = ''
  proc.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (line.trim() === '') continue
      try {
        frames.push({ ...(JSON.parse(line) as Record<string, unknown>), atMs: Date.now() })
      } catch {
      }
    }
  })
  proc.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  const exited = new Promise<void>(resolve => proc.on('exit', () => resolve()))
  return {
    frames,
    stderr: () => stderr,
    send: frame => proc.stdin!.write(`${JSON.stringify(frame)}\n`),
    stop: async graceMs => {
      try {
        proc.stdin!.end()
      } catch {
      }
      await Promise.race([exited, sleep(graceMs)])
      try {
        proc.kill('SIGKILL')
      } catch {
      }
    },
  }
}

const subtypeOf = (f: Frame): string => (f.type === 'system' ? String(f.subtype ?? '') : String(f.type))
const timeline = (frames: Frame[], t0: number): string =>
  frames
    .filter(f => f.type === 'result' || (f.type === 'system' && ['turn_started', 'task_notification', 'session_state_changed', 'status'].includes(String(f.subtype))))
    .map(f => `${((f.atMs - t0) / 1000).toFixed(2)}s ${subtypeOf(f)}${f.type === 'system' && f.subtype === 'session_state_changed' ? ` ${String((f as { state?: unknown }).state)}` : ''}${f.type === 'system' && f.subtype === 'status' ? ` ${JSON.stringify((f as { status?: unknown }).status)}` : ''}`)
    .join(' · ')

async function untilQuiet(runner: Runner, wantResults: number, quietMs: number, budgetMs: number): Promise<void> {
  const until = Date.now() + budgetMs
  while (Date.now() < until) {
    const results = runner.frames.filter(f => f.type === 'result').length
    const last = runner.frames.at(-1)?.atMs ?? 0
    if (results >= wantResults && Date.now() - last > quietMs) return
    await sleep(100)
  }
}

async function scenario(label: string, count: number, sleepsSeconds: number[], holdSeconds = 0): Promise<void> {
  tally.section(`${label}: ${count} background command${count === 1 ? '' : 's'} launched in one turn, ending ${sleepsSeconds.join('/')} s later ${holdSeconds > 0 ? `while the launch turn runs a ${holdSeconds} s foreground command` : 'on an idle main thread'}`)
  const runHome = realpathSync(mkdtempSync(join(tmpdir(), 'burst-home-')))
  const cwd = join(runHome, 'work')
  const stamps = join(cwd, 'stamps')
  const fixture: ScriptedFixture = await startScriptedFixture(req => {
    if (req.ask.includes(NOTIFICATION)) return [{ type: 'text', text: NOTED }]
    if (req.ask.trim() !== LAUNCH_ASK) return [{ type: 'text', text: 'ok' }]
    if (req.step === 0) {
      return sleepsSeconds.slice(0, count).map((s, i): WireBlock => ({ type: 'tool_use', name: 'Bash', input: { command: `sleep ${s}; echo burst-done-${i + 1}; touch ${stamps}/done-${i + 1}`, run_in_background: true, description: `burst command ${i + 1}` } }))
    }
    if (req.step === 1 && holdSeconds > 0) return [{ type: 'tool_use', name: 'Bash', input: { command: `sleep ${holdSeconds}`, description: 'hold the turn' } }]
    return [{ type: 'text', text: LAUNCHED }]
  })
  seedScratchHome(runHome, cwd)
  mkdirSync(stamps, { recursive: true })
  const port = Number(new URL(fixture.base).port)
  const runner = boot(cwd, childEnv(runHome, port))
  const t0 = Date.now()
  runner.send({ type: 'user', message: { role: 'user', content: LAUNCH_ASK }, uuid: randomUUID(), session_id: '' })
  await untilQuiet(runner, 1 + count, 6_000, vshotBudgetMs(60_000))
  await runner.stop(5_000)
  await fixture.close()
  console.log(`  timeline: ${timeline(runner.frames, t0)}`)
  const notificationRequests = fixture.requests.filter(r => r.askTexts.some(t => t.includes(NOTIFICATION)))
  const blocksPer = notificationRequests.map(r => r.askTexts.reduce((n, t) => n + t.split(NOTIFICATION).length - 1, 0))
  const turnsStarted = runner.frames.filter(f => f.type === 'system' && f.subtype === 'turn_started').length
  const results = runner.frames.filter(f => f.type === 'result').length
  const sdkNotifications = runner.frames.filter(f => f.type === 'system' && f.subtype === 'task_notification')
  const launched = fixture.requests.some(r => r.results.filter(x => /Running in the background/.test(x.text)).length === count)
  const completedAt = readdirSync(stamps).map(f => { try { return statSync(join(stamps, f)).mtimeMs } catch { return Number.NaN } }).filter(Number.isFinite)
  const firstCompletion = completedAt.length > 0 ? Math.min(...completedAt) : Number.NaN
  const launchResultAt = runner.frames.find(f => f.type === 'result')?.atMs ?? Number.NaN
  const foldStartAt = runner.frames.filter(f => f.type === 'system' && f.subtype === 'turn_started')[1]?.atMs ?? Number.NaN
  console.log(`  clock: launch result +${((launchResultAt - t0) / 1000).toFixed(2)}s · first completion +${((firstCompletion - t0) / 1000).toFixed(2)}s · the completions' turn +${((foldStartAt - t0) / 1000).toFixed(2)}s · window ${POLL_INTERVAL_MS} ms`)
  console.log(`  requests: ${fixture.requests.length} total · ${notificationRequests.length} carrying a notification · blocks per notification turn ${JSON.stringify(blocksPer)} · turn_started ${turnsStarted} · results ${results} · sdk task_notification frames ${sdkNotifications.length}`)
  tally.check(`${label} L1 the launch turn started ${count} background command${count === 1 ? '' : 's'} and ended with words`, launched && fixture.requests.some(r => r.step === 1), `${JSON.stringify(fixture.requests.map(r => [r.n, r.step, r.results.map(x => x.text.slice(0, 40))]))}`)
  tally.check(`${label} L2 every completion reached the model: ${count} notification block${count === 1 ? '' : 's'} in all`, blocksPer.reduce((a, b) => a + b, 0) === count, `blocks per notification turn ${JSON.stringify(blocksPer)}`)
  tally.check(`${label} L3 the completions started ONE turn, not ${count}: one request carries every notification`, notificationRequests.length === 1 && blocksPer[0] === count, `notification turns ${notificationRequests.length} · blocks ${JSON.stringify(blocksPer)}`)
  tally.check(`${label} L4 the wire's turn_started edges agree: ${1 + 1} turns for the launch and the fold`, turnsStarted === 2 && results === 2, `turn_started ${turnsStarted} · results ${results}`)
  tally.check(`${label} L5 the runner still speaks one task_notification frame per completion (${count})`, sdkNotifications.length === count && new Set(sdkNotifications.map(f => String((f as { task_id?: unknown }).task_id))).size === count, `${sdkNotifications.length} frames: ${JSON.stringify(sdkNotifications.map(f => (f as { task_id?: unknown }).task_id))}`)
  if (holdSeconds > 0) {
    tally.check(`${label} L6 completions that landed during the live turn were read as soon as it ended — no settle window after a turn`, Number.isFinite(foldStartAt) && Number.isFinite(launchResultAt) && foldStartAt - launchResultAt < POLL_INTERVAL_MS, `gap ${foldStartAt - launchResultAt} ms · window ${POLL_INTERVAL_MS} ms`)
  } else {
    tally.check(`${label} L6 the completions' turn began no sooner than the settle window after the first completion (the hold is the runner's task-poll second)`, Number.isFinite(foldStartAt) && Number.isFinite(firstCompletion) && foldStartAt - firstCompletion >= POLL_INTERVAL_MS - 250, `turn − first completion = ${Math.round(foldStartAt - firstCompletion)} ms · window ${POLL_INTERVAL_MS} ms`)
  }
  if (tally.failed() === 0) rmSync(runHome, { recursive: true, force: true })
  else console.log(`  world kept: ${runHome}\n  stderr tail: ${runner.stderr().slice(-600)}`)
}

await scenario('burst', 3, [3, 3.3, 3.6])
await scenario('single', 1, [3])
await scenario('during', 2, [1, 1.3], 4)
tally.finish()
