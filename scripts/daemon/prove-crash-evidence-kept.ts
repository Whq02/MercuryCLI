#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { mock } from 'bun:test'
import { SCRATCH_ROOT, makeTally, sleep } from './dupline-world.ts'
import type { StreamJsonChildSpec } from '../../src/daemon/headlessRun.ts'

const tally = makeTally('prove-crash-evidence-kept')
const scratch = mkdtempSync(join(SCRATCH_ROOT, 'crash-evidence-'))
const home = join(scratch, 'home')
const daemonHome = join(home, 'daemon')
mkdirSync(daemonHome, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonHome
process.env.MERCURY_CREDENTIAL_STORE = 'file'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — prove-crash-evidence-kept exceeded 120s')
  process.exit(1)
}, 120_000)
watchdog.unref?.()

const daemonLog: string[] = []
const realConsoleError = console.error
console.error = ((...args: unknown[]): void => {
  daemonLog.push(args.map(a => (typeof a === 'string' ? a : String(a))).join(' '))
}) as typeof console.error
const mirrored: Buffer[] = []
const realStderrWrite = process.stderr.write
process.stderr.write = ((chunk: string | Uint8Array): boolean => {
  mirrored.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk))
  return true
}) as typeof process.stderr.write

const realChildren = await import('../../src/daemon/headlessRun.ts')
const realSpawn = realChildren.spawnStreamJsonChild
type FakeChild = EventEmitter & { pid: number; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => boolean }
const FAKE_PID = 2_147_483_001
const fakes: FakeChild[] = []
let realFixture: string | null = null
mock.module('../../src/daemon/headlessRun.ts', () => ({
  ...realChildren,
  spawnStreamJsonChild: (spec: StreamJsonChildSpec, opts?: { respawn?: boolean }) => {
    const fake = fakes.shift()
    if (fake !== undefined) return { child: fake, argv: [], env: {} }
    if (realFixture === null) throw new Error('no fixture runner is armed for this spawn')
    const selfScript = process.argv[1]
    process.argv[1] = realFixture
    try {
      return realSpawn(spec, opts)
    } finally {
      process.argv[1] = selfScript
    }
  },
}))
const { TaskRoster } = await import('../../src/daemon/roster.ts')
const supervisor = await import('../../src/daemon/longLivedSupervisor.ts')
const concourse = await import('../../src/daemon/concourseSupervisor.ts')
const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 3 } }))

const roster = new TaskRoster({ dir: scratch, breaker: {} as never, maxInflight: 3 })
type SeatView = { child?: ChildProcess; longLived?: { stderrTail?: Buffer } }
const seatOf = (short: string): SeatView | undefined => (roster as unknown as { handles: Map<string, SeatView> }).handles.get(short)
const specOf = (short: string): StreamJsonChildSpec => ({
  cwd: scratch,
  model: 'fixture-model',
  effort: 'high',
  appendSystemPrompt: '',
  role: 'MERCURY_CONCOURSE_WORKER',
  agentName: short,
  agentId: `${short}-agent`,
  plainIdentity: true,
})
const RESEND = ' · resumed — the interrupted ask needs a re-send'
const envelope = {
  type: 'result',
  subtype: 'error_during_execution',
  duration_ms: 0,
  duration_api_ms: 0,
  is_error: true,
  num_turns: 0,
  stop_reason: null,
  session_id: 'fixture-session',
  total_cost_usd: 0,
  permission_denials: [],
  uuid: 'fixture-envelope',
  errors: ['TypeError: the fixture cycle threw', 'an older in-memory error'],
}
const ENVELOPE_TEXT = 'TypeError: the fixture cycle threw; an older in-memory error'

function fakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), {
    pid: FAKE_PID,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  })
}

function seed(short: string): void {
  concourse.updateConcourseWorkers(workers => {
    workers[short] = {
      runnerId: short,
      sessionId: `${short}-session`,
      workspaceId: scratch,
      modelKey: 'fixture-model',
      spawnedAt: Date.now(),
      lastLiveAt: Date.now(),
    } as never
  })
}

async function seatOnFake(short: string, cfg: Record<string, number> = {}): Promise<FakeChild> {
  const child = fakeChild()
  fakes.push(child)
  const registered = roster.registerLongLived(short, specOf(short), cfg)
  if (!registered.ok) console.log(`  (the fixture seat ${short} did not register: ${String(registered.error)})`)
  await sleep(30)
  seed(short)
  return child
}

async function seatOnReal(short: string, fixture: string, cfg: Record<string, number> = {}): Promise<void> {
  realFixture = fixture
  const registered = roster.registerLongLived(short, specOf(short), cfg)
  realFixture = null
  tally.check(`the fixture runner ${short} runs as a real child process`, registered.ok && typeof registered.pid === 'number', JSON.stringify(registered))
  seatOf(short)?.child?.once('close', () => roster.expectExit(short, true))
  await sleep(30)
  seed(short)
}

function exitAndClose(short: string, child: FakeChild): void {
  child.emit('exit', 1, null)
  child.emit('close', 1, null)
  roster.expectExit(short, true)
}

async function crashRowOf(short: string, ms = 8_000): Promise<string | undefined> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const reason = concourse.readSessionWorkers()[short]?.crash?.reason
    if (typeof reason === 'string') return reason
    await sleep(20)
  }
  return undefined
}

const crashLineOf = (short: string): string | undefined => daemonLog.find(line => line.includes(`long-lived ${short} crashed`))

console.log('============================================================')
console.log(' crash evidence kept — what a dying runner said reaches its crash row and daemon.log')
console.log(` platform: ${process.platform} — the same laws hold on every platform`)
console.log(" red on the base: §1 the envelope reads 'unknown error' (5 checks); §2 the tail helpers are absent (1); §3 the row and the log line (3); §4 the long-lived row loses its text to the healthy reset (2); §5 a recovered error is blamed (1); §6 the frame read after exit is missed (1); §7 no mirror, no tail, no stderr line in the row or the log (4); §9 the real refusing runner's row has no text (2); §10 the real runner's stderr bypasses the daemon (3) — 22 of 33")
console.log('============================================================')

tally.section('§1 the result frame names its error: errors[] when result is absent, the old wording when result is present')
{
  const text = supervisor.errorTextOfParsedResultFrame
  const said = (frame: Record<string, unknown> | null): string => String(text(frame))
  tally.check("a refusal envelope (errors[], no result) reads its first error, then the rest joined — never 'unknown error'", text(envelope) === ENVELOPE_TEXT, said(envelope))
  const long = { type: 'result', is_error: true, errors: ['E'.repeat(500), 'tail'] }
  tally.check('the 240-character cap holds on errors[] too', text(long) === 'E'.repeat(240), said(long))
  const multi = { type: 'result', is_error: true, errors: ['Error: first\n    at frame (fixture.js:1:1)'] }
  tally.check('a multi-line entry reads as one line', text(multi) === 'Error: first at frame (fixture.js:1:1)', said(multi))
  const mixed = { type: 'result', is_error: true, errors: ['  ', 7, null, 'the real one'] }
  tally.check('blank and non-string entries are skipped', text(mixed) === 'the real one', said(mixed))
  const carried = { type: 'result', is_error: true, result: 'API Error: 529 overloaded', errors: ['not read'] }
  tally.check("a frame that carries result keeps today's wording exactly (a string)", text(carried) === 'API Error: 529 overloaded', said(carried))
  tally.check('…an object result still reads as its JSON', text({ type: 'result', is_error: true, result: { code: 7 } }) === '{"code":7}')
  tally.check("…a null result still reads 'null'", text({ type: 'result', is_error: true, result: null }) === 'null')
  tally.check('…a long result is still capped at 240', text({ type: 'result', is_error: true, result: 'R'.repeat(300) }) === 'R'.repeat(240))
  tally.check(
    "no result and no usable errors[] still reads 'unknown error'",
    text({ type: 'result', is_error: true }) === 'unknown error' && text({ type: 'result', is_error: true, errors: [] }) === 'unknown error' && text({ type: 'result', is_error: true, errors: ['', ' '] }) === 'unknown error',
  )
  tally.check('a success result and a non-result frame carry no error text', text({ type: 'result', is_error: false, result: 'done' }) === undefined && text({ type: 'assistant' }) === undefined && text(null) === undefined)
  tally.check('the line reader agrees', supervisor.errorTextOfResultFrame(JSON.stringify(envelope)) === ENVELOPE_TEXT, String(supervisor.errorTextOfResultFrame(JSON.stringify(envelope))))
}

tally.section('§2 the stderr tail: the last 4 KB, and its last non-empty line')
{
  const helpers = supervisor as unknown as Record<string, unknown>
  const keep = helpers.keepStderrTail as ((tail: Buffer | undefined, chunk: Buffer) => Buffer) | undefined
  const last = helpers.lastStderrLine as ((tail: Buffer | undefined) => string | undefined) | undefined
  tally.check('the tail keeper and the line reader exist, bounded at 4096 bytes', typeof keep === 'function' && typeof last === 'function' && helpers.STDERR_TAIL_BYTES === 4096)
  if (typeof keep === 'function' && typeof last === 'function') {
    let tail: Buffer | undefined
    const written: Buffer[] = []
    for (let i = 0; i < 300; i++) {
      const chunk = Buffer.from(`line ${i} ${'x'.repeat(40)}\n`)
      written.push(chunk)
      tail = keep(tail, chunk)
    }
    const all = Buffer.concat(written)
    tally.check('the kept tail is exactly the last 4 KB, byte for byte', tail !== undefined && tail.length === 4096 && tail.equals(all.subarray(all.length - 4096)), `kept ${tail?.length ?? 'nothing'}`)
    tally.check('the last non-empty line skips blank lines and CRLF endings', last(Buffer.from('first\r\nError: the last words\r\n\r\n   \n')) === 'Error: the last words')
    tally.check('no tail and an all-blank tail read no line', last(undefined) === undefined && last(Buffer.from('\n \r\n')) === undefined)
    tally.check('a long last line is capped at 240', last(Buffer.from(`${'L'.repeat(400)}\n`))?.length === 240)
  }
}

tally.section("§3 a runner that refuses and exits: the crash row names the error instead of 'unknown error'")
{
  const short = 'concourse-w9001'
  const child = await seatOnFake(short)
  child.stdout.write(`${JSON.stringify(envelope)}\n`)
  await sleep(20)
  exitAndClose(short, child)
  const row = await crashRowOf(short)
  tally.check("the crash row carries the envelope's first error, the rest after it", row === `crashed mid-run (exit 1) — ${ENVELOPE_TEXT}${RESEND}`, String(row))
  tally.check("…and never reads 'unknown error'", row !== undefined && !row.includes('unknown error'), String(row))
  const line = crashLineOf(short)
  tally.check('the daemon log carries the crash line with its exit code, its signal and the kept error', line === `[daemon] long-lived ${short} crashed (code=1 sig=null); respawn (1/5) — ${ENVELOPE_TEXT}`, String(line))
}

tally.section('§4 a runner older than the healthy-reset window: the reset no longer wipes the error of the crash it handles')
{
  const short = 'concourse-w9002'
  const child = await seatOnFake(short, { healthyResetMs: 1 })
  child.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 500 the fixture upstream failed' })}\n`)
  await sleep(20)
  exitAndClose(short, child)
  const row = await crashRowOf(short)
  tally.check("the long-lived runner's crash row carries its error", row === `crashed mid-run (exit 1) — API Error: 500 the fixture upstream failed${RESEND}`, String(row))
  tally.check('…and so does its daemon log line', crashLineOf(short)?.includes('API Error: 500 the fixture upstream failed') === true, String(crashLineOf(short)))
}

tally.section('§5 an error a later turn recovered from is not blamed for the crash')
{
  const short = 'concourse-w9003'
  const child = await seatOnFake(short)
  child.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 529 the fixture was overloaded' })}\n`)
  child.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' })}\n`)
  await sleep(20)
  exitAndClose(short, child)
  const row = await crashRowOf(short)
  tally.check('the crash row reads the bare exit words, not the recovered error', row === `crashed mid-run (exit 1)${RESEND}`, String(row))
}

tally.section("§6 the row waits for the child's streams: what is read between 'exit' and 'close' lands in it")
{
  const short = 'concourse-w9004'
  const child = await seatOnFake(short)
  child.emit('exit', 1, null)
  child.stdout.write(`${JSON.stringify(envelope)}\n`)
  child.stderr.write('Error: written as the process ended\n')
  await sleep(20)
  child.emit('close', 1, null)
  roster.expectExit(short, true)
  const row = await crashRowOf(short)
  tally.check("the envelope read after 'exit' is in the row, and the result error outranks the stderr line", row === `crashed mid-run (exit 1) — ${ENVELOPE_TEXT}${RESEND}`, String(row))
}
{
  const short = 'concourse-w9005'
  const child = await seatOnFake(short)
  child.stdout.write(`${JSON.stringify(envelope)}\n`)
  await sleep(20)
  const exitAt = Date.now()
  child.emit('exit', 1, null)
  const row = await crashRowOf(short, 6_000)
  roster.expectExit(short, true)
  const waited = Date.now() - exitAt
  tally.check('a child whose streams stay open past its exit still gets its row within the backstop', row !== undefined && waited < 5_000, `${String(row)} after ${waited}ms`)
}

tally.section("§7 the runner's stderr is kept: mirrored byte for byte, its last 4 KB on the seat, its last line in the row")
{
  const short = 'concourse-w9006'
  const child = await seatOnFake(short)
  const pieces: Buffer[] = []
  for (let i = 0; i < 200; i++) pieces.push(Buffer.from(`noise ${i} ${'x'.repeat(50)}\n`))
  pieces.push(Buffer.from([0x00, 0xff, 0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x0a]))
  pieces.push(Buffer.from('Error: the fixture tail line\r\n\r\n'))
  const sent = Buffer.concat(pieces)
  mirrored.length = 0
  for (const piece of pieces) child.stderr.write(piece)
  await sleep(30)
  const kept = seatOf(short)?.longLived?.stderrTail
  tally.check("every stderr byte reached the daemon's own stderr, in order, byte for byte", Buffer.concat(mirrored).indexOf(sent) >= 0, `${Buffer.concat(mirrored).length} of ${sent.length} bytes mirrored`)
  tally.check('the seat keeps exactly the last 4 KB of it', kept !== undefined && kept.length === 4096 && kept.equals(sent.subarray(sent.length - 4096)), `kept ${kept?.length ?? 'nothing'}`)
  exitAndClose(short, child)
  const row = await crashRowOf(short)
  tally.check("with no result error, the crash row carries the stderr's last non-empty line", row === `crashed mid-run (exit 1) — Error: the fixture tail line${RESEND}`, String(row))
  tally.check('…and so does the daemon log line', crashLineOf(short)?.includes('crashed (code=1 sig=null); respawn (1/5) — Error: the fixture tail line') === true, String(crashLineOf(short)))
}

tally.section('§8 a requested stop still settles at the exit itself')
{
  const short = 'concourse-w9007'
  const child = await seatOnFake(short)
  roster.expectExit(short, true)
  child.emit('exit', 0, null)
  const entry = roster.list().find(e => e.short === short)
  tally.check("the stopped runner settles 'killed' at its exit, no close awaited", entry?.outcome === 'killed', JSON.stringify(entry))
  await sleep(50)
  tally.check('…and stamps no crash row', concourse.readSessionWorkers()[short]?.crash === undefined)
}

const refusing = join(scratch, 'refusing-runner.mjs')
writeFileSync(
  refusing,
  [
    `const envelope = ${JSON.stringify(envelope)}`,
    "setTimeout(() => process.stdout.write(JSON.stringify(envelope) + '\\n'), 300)",
    'setTimeout(() => process.exit(1), 2000)',
    '',
  ].join('\n'),
)
const speaking = join(scratch, 'stderr-runner.mjs')
writeFileSync(
  speaking,
  [
    "process.stderr.write('fixture runner: booting\\n')",
    "process.stderr.write('Error: the fixture runner could not continue\\r\\n\\r\\n')",
    'setTimeout(() => process.exit(1), 300)',
    '',
  ].join('\n'),
)

tally.section('§9 a real runner process: a refusal envelope, then exit 1 two seconds into its life (the healthy reset fires)')
{
  const short = 'concourse-w9101'
  await seatOnReal(short, refusing, { healthyResetMs: 1_000 })
  const row = await crashRowOf(short, 12_000)
  roster.expectExit(short, true)
  tally.check("the crash row carries the envelope's first error, the rest after it", row === `crashed mid-run (exit 1) — ${ENVELOPE_TEXT}${RESEND}`, String(row))
  const line = crashLineOf(short)
  tally.check('the daemon log line names exit code 1, no signal, and the error', line !== undefined && line.includes('crashed (code=1 sig=null)') && line.includes(ENVELOPE_TEXT), String(line))
}

tally.section('§10 a real runner process that speaks only on stderr, then exits 1: its words are mirrored and kept')
{
  const short = 'concourse-w9102'
  mirrored.length = 0
  await seatOnReal(short, speaking)
  const row = await crashRowOf(short, 12_000)
  roster.expectExit(short, true)
  const words = Buffer.from('fixture runner: booting\nError: the fixture runner could not continue\r\n\r\n')
  tally.check("the runner's stderr reached the daemon's own stderr byte for byte (daemon.log keeps what it had)", Buffer.concat(mirrored).indexOf(words) >= 0, `${Buffer.concat(mirrored).length} bytes mirrored`)
  tally.check("with no result error, the crash row carries the runner's last stderr line", row === `crashed mid-run (exit 1) — Error: the fixture runner could not continue${RESEND}`, String(row))
  tally.check('…and so does the daemon log line', crashLineOf(short)?.includes('crashed (code=1 sig=null); respawn (1/5) — Error: the fixture runner could not continue') === true, String(crashLineOf(short)))
}

clearTimeout(watchdog)
console.error = realConsoleError
process.stderr.write = realStderrWrite
try {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 })
} catch {
  console.log(`  scratch kept: ${scratch}`)
}
tally.finish()
