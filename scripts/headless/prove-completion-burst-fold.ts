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
const NOTICE_HEAD = '<task-notification>\n<task-id>'
const LAUNCH_ASK = 'burst: launch the background commands'
const LAUNCHED = 'burst: launched'
const NOTED = 'burst: noted'
const WORDS = 'burst: the operator speaks'
const WORDS_AGAIN = 'burst: and a second line, typed right after'
const WORDS_ANSWERED = 'burst: words answered'

type Frame = Record<string, unknown> & { atMs: number }
type Runner = { frames: Frame[]; send: (frame: Record<string, unknown>) => void; stop: (graceMs: number) => Promise<void>; stderr: () => string }
type World = { holdSeconds?: number; secondHoldSeconds?: number; finalAnswerDelayMs?: number; operatorWordsAfterCompletions?: boolean }

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

const noticesIn = (texts: readonly string[]): number => texts.reduce((n, t) => n + t.split(NOTICE_HEAD).length - 1, 0)

async function scenario(label: string, count: number, sleepsSeconds: number[], world: World = {}): Promise<void> {
  const holdSeconds = world.holdSeconds ?? 0
  const secondHoldSeconds = world.secondHoldSeconds ?? 0
  const finalDelayMs = world.finalAnswerDelayMs ?? 0
  const operatorWords = world.operatorWordsAfterCompletions === true
  const shape =
    holdSeconds > 0
      ? `while the launch turn runs a ${holdSeconds} s foreground command${secondHoldSeconds > 0 ? ` and then a ${secondHoldSeconds} s one` : ''}`
      : finalDelayMs > 0
        ? `while the launch turn's last model answer is still ${finalDelayMs / 1000} s away${operatorWords ? ', and the operator types two lines in a row after they land' : ''}`
        : 'on an idle main thread'
  tally.section(`${label}: ${count} background command${count === 1 ? '' : 's'} launched in one turn, ending ${sleepsSeconds.join('/')} s later ${shape}`)
  const runHome = realpathSync(mkdtempSync(join(tmpdir(), 'burst-home-')))
  const cwd = join(runHome, 'work')
  const stamps = join(cwd, 'stamps')
  const fixture: ScriptedFixture = await startScriptedFixture(
    req => {
      if (req.ask.includes(NOTIFICATION)) return [{ type: 'text', text: NOTED }]
      if (req.ask.trim().startsWith(WORDS) || req.ask.trim() === WORDS_AGAIN) return req.step === 0 ? [{ type: 'tool_use', name: 'Bash', input: { command: 'true', description: 'a quick look' } }] : [{ type: 'text', text: WORDS_ANSWERED }]
      if (req.ask.trim() !== LAUNCH_ASK) return [{ type: 'text', text: 'ok' }]
      if (req.step === 0) {
        return sleepsSeconds.slice(0, count).map((s, i): WireBlock => ({ type: 'tool_use', name: 'Bash', input: { command: `sleep ${s}; echo burst-done-${i + 1}; touch ${stamps}/done-${i + 1}`, run_in_background: true, description: `burst command ${i + 1}` } }))
      }
      if (req.step === 1 && holdSeconds > 0) return [{ type: 'tool_use', name: 'Bash', input: { command: `sleep ${holdSeconds}`, description: 'hold the turn' } }]
      if (req.step === 2 && secondHoldSeconds > 0) return [{ type: 'tool_use', name: 'Bash', input: { command: `sleep ${secondHoldSeconds}`, description: 'hold the turn again' } }]
      return [{ type: 'text', text: LAUNCHED }]
    },
    { answerDelayMs: req => (req.ask.trim() === LAUNCH_ASK && req.step === 1 && holdSeconds === 0 ? finalDelayMs : 0) },
  )
  seedScratchHome(runHome, cwd)
  mkdirSync(stamps, { recursive: true })
  const port = Number(new URL(fixture.base).port)
  const runner = boot(cwd, childEnv(runHome, port))
  const t0 = Date.now()
  runner.send({ type: 'user', message: { role: 'user', content: LAUNCH_ASK }, uuid: randomUUID(), session_id: '' })
  let wordsSentAt = Number.NaN
  const typedUuids = [randomUUID(), randomUUID()]
  if (operatorWords) {
    const until = Date.now() + vshotBudgetMs(20_000)
    while (Date.now() < until && readdirSync(stamps).length < count) await sleep(50)
    await sleep(300)
    wordsSentAt = Date.now()
    runner.send({ type: 'user', message: { role: 'user', content: WORDS }, uuid: typedUuids[0], session_id: '' })
    runner.send({ type: 'user', message: { role: 'user', content: WORDS_AGAIN }, uuid: typedUuids[1], session_id: '' })
  }
  const expectedTurns = holdSeconds > 0 ? 1 : 2
  await untilQuiet(runner, expectedTurns, 6_000, vshotBudgetMs(60_000))
  await runner.stop(5_000)
  await fixture.close()
  console.log(`  timeline: ${timeline(runner.frames, t0)}`)
  const noticesPerRequest = fixture.requests.map(r => noticesIn(r.allTexts))
  const newNoticesPerRequest = noticesPerRequest.map((n, i) => n - (noticesPerRequest[i - 1] ?? 0))
  const carrying = fixture.requests.filter((_, i) => newNoticesPerRequest[i]! > 0)
  const blocksPer = carrying.map(r => newNoticesPerRequest[fixture.requests.indexOf(r)]!)
  const turnsStarted = runner.frames.filter(f => f.type === 'system' && f.subtype === 'turn_started').length
  const results = runner.frames.filter(f => f.type === 'result').length
  const sdkNotifications = runner.frames.filter(f => f.type === 'system' && f.subtype === 'task_notification')
  const launched = fixture.requests.some(r => r.results.filter(x => /Running in the background/.test(x.text)).length === count)
  const completedAt = readdirSync(stamps).map(f => { try { return statSync(join(stamps, f)).mtimeMs } catch { return Number.NaN } }).filter(Number.isFinite)
  const firstCompletion = completedAt.length > 0 ? Math.min(...completedAt) : Number.NaN
  const launchResultAt = runner.frames.find(f => f.type === 'result')?.atMs ?? Number.NaN
  const foldStartAt = runner.frames.filter(f => f.type === 'system' && f.subtype === 'turn_started')[1]?.atMs ?? Number.NaN
  const carriedAt = carrying[0]?.atMs ?? Number.NaN
  const lastCompletion = completedAt.length > 0 ? Math.max(...completedAt) : Number.NaN
  const launchLastN = Math.max(...fixture.requests.filter(r => r.ask.trim() === LAUNCH_ASK).map(r => r.n))
  const nextAfterLaunch = fixture.requests.find(r => r.n === launchLastN + 1)
  const secondOpen = runner.frames.findIndex((f, i) => f.type === 'system' && f.subtype === 'turn_started' && runner.frames.slice(0, i).some(g => g.type === 'system' && g.subtype === 'turn_started'))
  const askLines = (r: { askTexts: string[] } | undefined): string[] => (r?.askTexts ?? []).flatMap(t => t.split('\n')).map(l => l.trim()).filter(l => l !== '')
  const bothLines = (r: { askTexts: string[] } | undefined): boolean => JSON.stringify(askLines(r)) === JSON.stringify([WORDS, WORDS_AGAIN])
  const secondEdgeUuids = secondOpen >= 0 ? ((runner.frames[secondOpen] as { uuids?: unknown }).uuids as string[] | undefined) ?? [] : []
  console.log(`  clock: launch result +${((launchResultAt - t0) / 1000).toFixed(2)}s · first completion +${((firstCompletion - t0) / 1000).toFixed(2)}s · the carrying request +${((carriedAt - t0) / 1000).toFixed(2)}s (${Math.round(carriedAt - firstCompletion)} ms after the first completion) · the completions' turn +${((foldStartAt - t0) / 1000).toFixed(2)}s · window ${POLL_INTERVAL_MS} ms`)
  console.log(`  requests: ${fixture.requests.length} total · ${carrying.length} carrying a notification · blocks per carrying request ${JSON.stringify(blocksPer)} · turn_started ${turnsStarted} · results ${results} · sdk task_notification frames ${sdkNotifications.length}`)
  if (operatorWords) console.log(`  asks: ${fixture.requests.map(r => `#${r.n} step ${r.step} ${JSON.stringify(askLines(r))}`).join(' · ')} · the second open edge names ${JSON.stringify(secondEdgeUuids.map(u => (u === typedUuids[0] ? 'line 1' : u === typedUuids[1] ? 'line 2' : u)))}`)
  tally.check(`${label} L1 the launch turn started ${count} background command${count === 1 ? '' : 's'} and ended with words`, launched && fixture.requests.some(r => r.step === 1), `${JSON.stringify(fixture.requests.map(r => [r.n, r.step, r.results.map(x => x.text.slice(0, 40))]))}`)
  tally.check(`${label} L2 every completion reached the model: ${count} notification block${count === 1 ? '' : 's'} in all`, blocksPer.reduce((a, b) => a + b, 0) === count, `blocks per carrying request ${JSON.stringify(blocksPer)}`)
  tally.check(`${label} L3 one request carries every notification, not ${count}`, carrying.length === 1 && blocksPer[0] === count, `carrying requests ${carrying.length} · blocks ${JSON.stringify(blocksPer)}`)
  if (holdSeconds > 0) {
    tally.check(`${label} L4 the wire's turn_started edges agree: ONE turn — the completions rode the live turn at its next tool boundary, no fold turn was needed`, turnsStarted === 1 && results === 1, `turn_started ${turnsStarted} · results ${results}`)
  } else if (operatorWords) {
    tally.check(`${label} L4 the wire's turn_started edges agree: ${1 + 1} turns — the launch and ONE turn for the operator's two lines; the completions rode that turn, no fold turn of their own and no turn of the second line's own`, turnsStarted === 2 && results === 2, `turn_started ${turnsStarted} · results ${results}`)
  } else {
    tally.check(`${label} L4 the wire's turn_started edges agree: ${1 + 1} turns for the launch and the fold`, turnsStarted === 2 && results === 2, `turn_started ${turnsStarted} · results ${results}`)
  }
  const distinctTasks = new Set(sdkNotifications.map(f => String((f as { task_id?: unknown }).task_id))).size
  if (holdSeconds > 0) {
    const lastWordsAt = runner.frames.findIndex(f => f.type === 'assistant' && JSON.stringify(f).includes(LAUNCHED))
    const frameIndexes = sdkNotifications.map(f => runner.frames.indexOf(f))
    tally.check(`${label} L5 the runner speaks one task_notification frame per completion (${count}), each on the wire before the turn's closing words`, sdkNotifications.length === count && distinctTasks === count && lastWordsAt >= 0 && frameIndexes.every(i => i < lastWordsAt), `${sdkNotifications.length} frames at wire positions ${JSON.stringify(frameIndexes)} · the closing words at ${lastWordsAt} · task ids ${JSON.stringify(sdkNotifications.map(f => (f as { task_id?: unknown }).task_id))}`)
    tally.check(`${label} L6 completions that landed during the live turn were read inside it: the request carrying them is a request of the launch turn, sent after the first completion`, carrying.length === 1 && carrying[0]!.ask.trim() === LAUNCH_ASK && Number.isFinite(carriedAt) && carriedAt > firstCompletion, `carrying ask ${JSON.stringify(carrying[0]?.ask.slice(0, 60))} · carried at +${((carriedAt - t0) / 1000).toFixed(2)}s · first completion +${((firstCompletion - t0) / 1000).toFixed(2)}s`)
    if (secondHoldSeconds > 0) {
      tally.check(`${label} L7 the completions were read at the FIRST tool boundary after they landed — before the second command ran, not after the whole turn`, carrying.length === 1 && carrying[0]!.step === 2 && Number.isFinite(carriedAt) && carriedAt - firstCompletion < secondHoldSeconds * 1000, `carrying request step ${carrying[0]?.step} · read ${Math.round(carriedAt - firstCompletion)} ms after the first completion · the second command alone takes ${secondHoldSeconds * 1000} ms`)
    }
  } else if (operatorWords) {
    const frameIndexes = sdkNotifications.map(f => runner.frames.indexOf(f))
    tally.check(`${label} L5 the runner speaks one task_notification frame per completion (${count}), each on the wire inside the operator's turn, after its open edge`, sdkNotifications.length === count && distinctTasks === count && secondOpen >= 0 && frameIndexes.every(i => i > secondOpen), `${sdkNotifications.length} frames at wire positions ${JSON.stringify(frameIndexes)} · the second turn's open edge at ${secondOpen}`)
    tally.check(`${label} L6 the turn after the launch was the operator's, not the completions': the request after the launch turn's last carries BOTH typed lines as one ask, and so does the request carrying the completions`, nextAfterLaunch !== undefined && bothLines(nextAfterLaunch) && carrying.length === 1 && bothLines(carrying[0]), `next ask ${JSON.stringify(askLines(nextAfterLaunch))} · carrying ask ${JSON.stringify(askLines(carrying[0]))}`)
    tally.check(`${label} L7 the completions were read at the operator's turn's first tool boundary (its second request), and the lines were typed after they landed`, carrying.length === 1 && carrying[0]!.step === 1 && Number.isFinite(wordsSentAt) && wordsSentAt > lastCompletion, `carrying request step ${carrying[0]?.step} · the lines typed at +${((wordsSentAt - t0) / 1000).toFixed(2)}s · last completion +${((lastCompletion - t0) / 1000).toFixed(2)}s`)
    tally.check(`${label} L8 the two lines were never split: the operator turn's open edge names both typed uuids, and no request's ask is the second line alone`, secondEdgeUuids.includes(typedUuids[0]) && secondEdgeUuids.includes(typedUuids[1]) && !fixture.requests.some(r => JSON.stringify(askLines(r)) === JSON.stringify([WORDS_AGAIN])), `the second open edge's uuids ${JSON.stringify(secondEdgeUuids.map(u => (u === typedUuids[0] ? 'line 1' : u === typedUuids[1] ? 'line 2' : u)))} · asks ${JSON.stringify(fixture.requests.map(askLines))}`)
  } else {
    tally.check(`${label} L5 the runner still speaks one task_notification frame per completion (${count})`, sdkNotifications.length === count && distinctTasks === count, `${sdkNotifications.length} frames: ${JSON.stringify(sdkNotifications.map(f => (f as { task_id?: unknown }).task_id))}`)
    if (finalDelayMs > 0) {
      tally.check(`${label} L6 completions that landed after the turn's last tool boundary fold at its end, read as soon as it ended — no settle window after a turn`, Number.isFinite(foldStartAt) && Number.isFinite(launchResultAt) && firstCompletion < launchResultAt && foldStartAt - launchResultAt < POLL_INTERVAL_MS, `first completion +${((firstCompletion - t0) / 1000).toFixed(2)}s · result +${((launchResultAt - t0) / 1000).toFixed(2)}s · gap ${Math.round(foldStartAt - launchResultAt)} ms · window ${POLL_INTERVAL_MS} ms`)
    } else {
      tally.check(`${label} L6 the completions' turn began no sooner than the settle window after the first completion (the hold is the runner's task-poll second)`, Number.isFinite(foldStartAt) && Number.isFinite(firstCompletion) && foldStartAt - firstCompletion >= POLL_INTERVAL_MS - 250, `turn − first completion = ${Math.round(foldStartAt - firstCompletion)} ms · window ${POLL_INTERVAL_MS} ms`)
    }
  }
  if (tally.failed() === 0) rmSync(runHome, { recursive: true, force: true })
  else console.log(`  world kept: ${runHome}\n  stderr tail: ${runner.stderr().slice(-600)}`)
}

await scenario('burst', 3, [3, 3.3, 3.6])
await scenario('single', 1, [3])
await scenario('during', 2, [1, 1.3], { holdSeconds: 4 })
await scenario('long', 2, [1, 1.3], { holdSeconds: 3, secondHoldSeconds: 4 })
await scenario('late', 2, [1.5, 1.8], { finalAnswerDelayMs: 3500 })
await scenario('words', 2, [1.5, 1.8], { finalAnswerDelayMs: 4500, operatorWordsAfterCompletions: true })
tally.finish()
