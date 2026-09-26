#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, MODEL, NODE, SCRATCH_ROOT, bound, childEnv, makeTally, sleep, user, type Frame } from '../daemon/dupline-world.ts'
import { seedScratchHome, startScriptedFixture, type ScriptedFixture } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-parked-ask-liveness')
if (!existsSync(DIST)) {
  console.log(`Build missing: ${DIST} — build first (bun run build.ts) or pass --dist <path/to/mercury.mjs>`)
  process.exit(1)
}
console.log(`build under proof: ${DIST}`)

const seatsToReap: Array<() => void> = []
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the parked-ask proof exceeded 180s; the seats are killed')
  for (const reap of seatsToReap) reap()
  process.exit(1)
}, 180_000)
guard.unref?.()

const ASK = 'ask the operator which way to go'
const DONE = 'the model carried on after the ask settled'
const AGAIN = 'are you still there'
const STILL = 'still here'
const HOST_DENY = 'the operator declined at the switchboard'
const ABORT_TEXT = 'Tool permission request failed: Tool permission request was aborted'
const STREAM_CLOSED_TEXT = 'Tool permission request failed: Permission stream closed before response was received for request '
const DENIED_LEAD = 'Permission to use AskUserQuestion has been denied: '
const CLIENT_AWAY_WORDS = "the operator's client was not there to answer"
const QUESTION = { questions: [{ question: 'Which way?', header: 'Way', options: [{ label: 'left', description: 'go left' }, { label: 'right', description: 'go right' }], multiSelect: false }] }
const j = (v: unknown): string => JSON.stringify(v)

type Seat = {
  frames: Array<{ frame: Frame; at: number }>
  send: (frame: Frame) => void
  endInput: () => void
  waitFor: (label: string, test: (f: Frame) => boolean, timeoutMs: number, after?: number) => Promise<Frame | null>
  exited: Promise<number | null>
  exitCode: () => number | null
  alive: () => boolean
  stop: (graceMs: number) => Promise<number | null>
  stderr: () => string
}

function bootSeat(args: { cwd: string; env: NodeJS.ProcessEnv }): Seat {
  const argv = [DIST, '-p', '--input-format=stream-json', '--output-format=stream-json', '--permission-channel', 'stdio', '--permission-mode', 'default', '--model', MODEL]
  const proc = spawn(NODE, argv, { cwd: args.cwd, env: args.env, stdio: ['pipe', 'pipe', 'pipe'] })
  const frames: Array<{ frame: Frame; at: number }> = []
  const waiters: Array<{ test: (f: Frame) => boolean; resolve: (f: Frame) => void }> = []
  let buffer = ''
  let stderrText = ''
  let alive = true
  let exitCode: number | null = null
  proc.stdin!.on('error', () => {})
  proc.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (line.trim() === '') continue
      try {
        const frame = JSON.parse(line) as Frame
        frames.push({ frame, at: Date.now() })
        for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]!.test(frame)) waiters.splice(i, 1)[0]!.resolve(frame)
      } catch {
      }
    }
  })
  proc.stderr!.on('data', (chunk: Buffer) => {
    stderrText += chunk.toString('utf8')
  })
  const exited = new Promise<number | null>(resolve =>
    proc.on('exit', code => {
      alive = false
      exitCode = code
      resolve(code)
    }),
  )
  const waitFor = (label: string, test: (f: Frame) => boolean, timeoutMs: number, after = 0): Promise<Frame | null> => {
    const seen = frames.slice(after).find(entry => test(entry.frame))
    if (seen !== undefined) return Promise.resolve(seen.frame)
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        const at = waiters.findIndex(w => w.resolve === done)
        if (at >= 0) waiters.splice(at, 1)
        console.log(`  [wait] ${label}: nothing within ${timeoutMs} ms`)
        resolve(null)
      }, timeoutMs)
      const done = (f: Frame): void => {
        clearTimeout(timer)
        resolve(f)
      }
      waiters.push({ test, resolve: done })
    })
  }
  const kill = (): void => {
    try {
      proc.kill('SIGKILL')
    } catch {
    }
  }
  seatsToReap.push(kill)
  return {
    frames,
    send: frame => {
      if (!alive) return
      proc.stdin!.write(`${j(frame)}\n`)
    },
    endInput: () => {
      try {
        proc.stdin!.end()
      } catch {
      }
    },
    waitFor,
    exited,
    exitCode: () => exitCode,
    alive: () => alive,
    stderr: () => stderrText,
    stop: async graceMs => {
      try {
        proc.stdin!.end()
      } catch {
      }
      const code = await Promise.race([exited, sleep(graceMs).then(() => null)])
      kill()
      return code
    },
  }
}

const isInit = (f: Frame): boolean => f.type === 'system' && f.subtype === 'init'
const isResult = (f: Frame): boolean => f.type === 'result'
const isAsk = (f: Frame): boolean => f.type === 'control_request' && (f.request as { subtype?: unknown } | undefined)?.subtype === 'can_use_tool'
const askOf = (f: Frame): { requestId: string; toolName: string; toolUseId: string } => {
  const request = (f.request ?? {}) as { tool_name?: unknown; tool_use_id?: unknown }
  return { requestId: String(f.request_id ?? ''), toolName: String(request.tool_name ?? ''), toolUseId: String(request.tool_use_id ?? '') }
}
type ToolResult = { toolUseId: string; text: string; isError: boolean }
function toolResultsOf(f: Frame): ToolResult[] {
  const content = (f.message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return []
  const out: ToolResult[] = []
  for (const block of content as Array<{ type?: string; tool_use_id?: unknown; content?: unknown; is_error?: unknown }>) {
    if (block.type !== 'tool_result') continue
    const text = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? (block.content as Array<{ type?: string; text?: string }>).map(part => (part.type === 'text' ? (part.text ?? '') : '')).join('') : ''
    out.push({ toolUseId: String(block.tool_use_id ?? ''), text, isError: block.is_error === true })
  }
  return out
}
const CUT_WORDS = /Request cut off|no-progress timeout|provider went quiet|unattended turn: no progress/
const cutWordsOf = (f: Frame): string | null => {
  if (f.type === 'control_request' || f.type === 'control_response') return null
  const text = j(f)
  const hit = CUT_WORDS.exec(text)
  if (hit === null) return null
  const start = Math.max(0, hit.index - 20)
  return text.slice(start, start + 260)
}
const errorsOf = (f: Frame | null): string => (Array.isArray(f?.errors) ? (f!.errors as unknown[]).map(String).join(' | ') : '')

function evidence(fixture: ScriptedFixture, seat: Seat, t0: number, toolUseId: string): void {
  console.log(`  provider requests: ${fixture.requests.map(r => `#${r.n} step ${r.step} ask=${j(r.ask.slice(0, 40))} results=${j(r.results.map(x => `${x.isError ? 'error ' : ''}${x.text.slice(0, 90)}`))}`).join(' · ') || 'none'}`)
  console.log('  timeline:')
  for (const row of timeline(seat, t0, toolUseId)) console.log(`    ${row}`)
}

function timeline(seat: Seat, t0: number, toolUseId: string): string[] {
  const rows: string[] = []
  for (const { frame, at } of seat.frames) {
    if (at < t0 - 50) continue
    const stamp = `${((at - t0) / 1000).toFixed(2)}s`
    if (isAsk(frame)) rows.push(`${stamp} control_request can_use_tool ${askOf(frame).toolName}`)
    for (const r of toolResultsOf(frame)) if (r.toolUseId === toolUseId) rows.push(`${stamp} tool_result${r.isError ? ' (error)' : ''}: ${j(r.text.slice(0, 200))}`)
    const cut = cutWordsOf(frame)
    if (cut !== null) rows.push(`${stamp} ${frame.type}${frame.subtype ? '/' + String(frame.subtype) : ''} carries the cut words: ${j(cut)}`)
    if (isResult(frame)) rows.push(`${stamp} result ${String(frame.subtype)} is_error=${String(frame.is_error)} result=${j(String(frame.result ?? '').slice(0, 160))}${errorsOf(frame) ? ' errors=' + j(errorsOf(frame).slice(0, 200)) : ''}`)
  }
  return rows
}

const WORLDS = process.env.MERCURY_CONFIG_DIR ?? SCRATCH_ROOT
mkdirSync(WORLDS, { recursive: true })

function world(key: string): { home: string; cwd: string } {
  const root = realpathSync(mkdtempSync(join(WORLDS, `parked-ask-${key}-`)))
  const home = join(root, 'home')
  const cwd = join(root, 'work')
  seedScratchHome(home, cwd)
  return { home, cwd }
}

function script(req: { allTexts: string[]; step: number }): Array<{ type: 'text'; text: string } | { type: 'tool_use'; name: string; input: Record<string, unknown> }> {
  if (req.allTexts.some(text => text.trim() === AGAIN)) return [{ type: 'text', text: STILL }]
  if (req.step === 0) return [{ type: 'tool_use', name: 'AskUserQuestion', input: QUESTION }]
  return [{ type: 'text', text: DONE }]
}

async function openSeat(key: string, idleMinutes: string): Promise<{ seat: Seat; fixture: ScriptedFixture; ask: Frame | null; t0: number }> {
  const w = world(key)
  const fixture = await startScriptedFixture(script)
  const seat = bootSeat({ cwd: w.cwd, env: { ...childEnv(w.home, Number(new URL(fixture.base).port)), MERCURY_HEADLESS_IDLE_MINUTES: idleMinutes } })
  seat.send(user(ASK, randomUUID()))
  const init = await seat.waitFor('system/init', isInit, bound(60_000))
  tally.check(`${key}: the seat booted in default mode with the stdio ask road`, init !== null && init.permission_mode === 'default', init === null ? `stderr ${j(seat.stderr().slice(-300))}` : `permission_mode ${String(init.permission_mode)}`)
  const ask = await seat.waitFor('the can_use_tool ask', isAsk, bound(60_000))
  const t0 = Date.now()
  tally.check(`${key}: the question left the seat as a can_use_tool ask parked with the host`, ask !== null && askOf(ask).toolName === 'AskUserQuestion', ask === null ? `frames ${j(seat.frames.map(e => e.frame.type))} stderr ${j(seat.stderr().slice(-300))}` : j(askOf(ask)))
  return { seat, fixture, ask, t0 }
}

const LIMIT_MINUTES = '0.05'
const LIMIT_MS = 3_000
const HOLD_MS = Math.round(LIMIT_MS * 3.5)

tally.section(`L1 — an ask parked with a silent host outlives the unattended-turn limit (${LIMIT_MS} ms); the host's later deny settles the tool and the turn carries on`)
{
  const { seat, fixture, ask, t0 } = await openSeat('park', LIMIT_MINUTES)
  if (ask !== null) {
    const { requestId, toolUseId } = askOf(ask)
    const mark = seat.frames.length
    const early = await seat.waitFor('a result or a cut while the ask is parked', f => isResult(f) || cutWordsOf(f) !== null || toolResultsOf(f).some(r => r.toolUseId === toolUseId), HOLD_MS, mark)
    const heldMs = Date.now() - t0
    const requestsWhileParked = fixture.requests.length
    tally.check(`L1: the parked ask outlived 3.5x the limit with no cut, no result and no tool error minted (${heldMs} ms held)`, early === null && seat.alive(), early === null ? `the seat exited (${seat.exitCode()})` : `after ${heldMs} ms: ${j(early).slice(0, 300)}`)
    tally.check('L1: nothing the seat wrote while the ask was parked blames the provider', !seat.frames.slice(mark).some(e => cutWordsOf(e.frame) !== null), j(seat.frames.slice(mark).map(e => cutWordsOf(e.frame)).filter(Boolean)).slice(0, 300))
    tally.check('L1: no provider request was issued while the ask was parked (the first request answered with the tool call is the only one)', requestsWhileParked === 1, `${requestsWhileParked} request(s)`)
    const beforeAnswer = seat.frames.length
    seat.send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message: HOST_DENY } } })
    const result = await seat.waitFor('the result after the host answered', isResult, bound(30_000), beforeAnswer)
    const toolError = seat.frames.slice(beforeAnswer).flatMap(e => toolResultsOf(e.frame)).find(r => r.toolUseId === toolUseId)
    const second = fixture.requests[1]
    tally.check("L1: the host's deny settled as the tool's error result", toolError !== undefined && toolError.isError && toolError.text.includes(HOST_DENY), j(toolError ?? null))
    tally.check('L1: the NEXT provider request was issued and consumed, carrying that error (the fixture saw request 2)', fixture.requests.length === 2 && second !== undefined && second.results.some(r => r.isError && r.text.includes(HOST_DENY)), `${fixture.requests.length} request(s) · request 2 results ${j(second?.results ?? null).slice(0, 300)}`)
    tally.check("L1: the turn ended with the model's own text, never the timer's words", result !== null && result.subtype === 'success' && result.result === DONE, result === null ? 'no result' : `${String(result.subtype)} ${j(String(result.result ?? '')).slice(0, 200)} ${errorsOf(result).slice(0, 200)}`)
    const code = await seat.stop(bound(10_000))
    tally.check('L1: the seat stays alive through the parked ask and exits 0 when the host closes the stream', code === 0, `exit ${code} stderr ${j(seat.stderr().slice(-300))}`)
    evidence(fixture, seat, t0, toolUseId)
  } else {
    await seat.stop(bound(5_000))
  }
  await fixture.close()
}

tally.section("L2 — the host's interrupt while the ask is parked ends the turn at once, the abort as the tool's error, no request after it")
{
  const { seat, fixture, ask, t0 } = await openSeat('interrupt', '0.5')
  if (ask !== null) {
    const { toolUseId } = askOf(ask)
    await sleep(1_500)
    const before = seat.frames.length
    const sentAt = Date.now()
    seat.send({ type: 'control_request', request_id: `stop-${randomUUID()}`, request: { subtype: 'interrupt' } })
    const result = await seat.waitFor('the result after the interrupt', isResult, bound(10_000), before)
    const endedMs = Date.now() - sentAt
    const toolError = seat.frames.slice(before).flatMap(e => toolResultsOf(e.frame)).find(r => r.toolUseId === toolUseId)
    tally.check(`L2: the turn ended within a moment of the interrupt (${endedMs} ms)`, result !== null && endedMs < bound(3_000), result === null ? 'no result' : `${endedMs} ms`)
    tally.check("L2: the aborted ask settled as the tool's error with the abort's own words", toolError !== undefined && toolError.isError && toolError.text.includes(ABORT_TEXT), j(toolError ?? null))
    await sleep(1_000)
    tally.check('L2: no provider request followed the abort on its own — the tool error is the final result of the turn', fixture.requests.length === 1 && seat.alive(), `${fixture.requests.length} request(s) · alive ${seat.alive()}`)
    tally.check("L2: the cut reads as the operator's interruption, not a provider timeout", result !== null && !seat.frames.slice(before).some(e => /provider went quiet|no-progress timeout/.test(j(e.frame)) && e.frame.type !== 'control_request'), j(seat.frames.slice(before).map(e => cutWordsOf(e.frame)).filter(Boolean)).slice(0, 300))
    const again = seat.frames.length
    seat.send(user(AGAIN, randomUUID()))
    const next = await seat.waitFor('the next turn after the interrupt', isResult, bound(30_000), again)
    tally.check('L2: the seat is alive after the interrupt and answers the next prompt', next !== null && next.result === STILL, next === null ? 'no result' : j(String(next.result ?? '')).slice(0, 120))
    const code = await seat.stop(bound(10_000))
    tally.check('L2: the seat exits 0 when the host closes the stream', code === 0, `exit ${code}`)
    evidence(fixture, seat, t0, toolUseId)
  } else {
    await seat.stop(bound(5_000))
  }
  await fixture.close()
}

tally.section('L3 — the host leaves while the ask is parked: the ask settles as a denial the model can read, and the turn carries on to its end')
{
  const { seat, fixture, ask, t0 } = await openSeat('gone', '0.5')
  if (ask !== null) {
    const { toolUseId } = askOf(ask)
    await sleep(1_000)
    const before = seat.frames.length
    const leftAt = Date.now()
    seat.endInput()
    const result = await seat.waitFor('the result after the host left', isResult, bound(30_000), before)
    const settledMs = Date.now() - leftAt
    const toolError = seat.frames.slice(before).flatMap(e => toolResultsOf(e.frame)).find(r => r.toolUseId === toolUseId)
    const second = fixture.requests[1]
    const text = toolError?.text ?? ''
    const closedShape = text.includes(STREAM_CLOSED_TEXT)
    const denialShape = text.includes(DENIED_LEAD) && text.includes(CLIENT_AWAY_WORDS)
    tally.check('L3: the ask settled as a tool error the model can read (not the abort text)', toolError !== undefined && toolError.isError && !text.includes(ABORT_TEXT), j(toolError ?? null))
    tally.check(`L3: the error wears one of the two known shapes — the stream-closed failure or the typed denial (${closedShape ? 'stream-closed' : denialShape ? 'typed denial' : 'neither'})`, closedShape || denialShape, j(text.slice(0, 300)))
    console.log(`  the denial the model read: ${j(text)}`)
    tally.check('L3: the NEXT provider request was issued and consumed, carrying that error', fixture.requests.length === 2 && second !== undefined && second.results.some(r => r.isError), `${fixture.requests.length} request(s) · request 2 results ${j(second?.results ?? null).slice(0, 300)}`)
    tally.check(`L3: the turn ended with the model's own text within seconds (${settledMs} ms)`, result !== null && result.result === DONE && settledMs < bound(15_000), result === null ? 'no result' : `${String(result.subtype)} ${j(String(result.result ?? '')).slice(0, 200)}`)
    const code = await seat.stop(bound(10_000))
    tally.check('L3: the seat exits 0 once the turn is over', code === 0, `exit ${code} stderr ${j(seat.stderr().slice(-300))}`)
    evidence(fixture, seat, t0, toolUseId)
  } else {
    await seat.stop(bound(5_000))
  }
  await fixture.close()
}

tally.finish()
