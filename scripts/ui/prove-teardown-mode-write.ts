#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-teardown-mode-write.ts — a terminal that hung up takes
//  no mode bytes.
//
//  The class: the runtime wakes the stdin reader for a HANGUP the way it
//  wakes it for input (the terminal's EOF arrives as a readable event), and
//  the gap-reassert that follows a quiet spell wrote the terminal modes to
//  a PTY whose master had just closed. The write answered EIO a turn later
//  — an uncaught exception — and every session that ended with its
//  terminal (a closed window, a capture's budget) left a crash record
//  behind. Two seams close it:
//    · the reader treats only INPUT as a resume: an EOF wake reads nothing
//      and reasserts nothing (App.handleReadable);
//    · the mode reassert refuses a stream that can no longer take a write —
//      destroyed, ended, unwritable — and an unmounted instance
//      (Ink.reassertTerminalModes; streamTakesWrites is the one predicate).
//
//    §1 the predicate, pure;
//    §2 the reassert against a torn-down stdout, LIVE through the real
//       runtime: a healthy stdout takes the mode bytes (the control), a
//       destroyed or unwritable one takes nothing, and the guard reads the
//       stream each time — never a latch;
//    §3 the stdin gap, LIVE: an EOF wake after the quiet spell writes no
//       mode bytes; a keystroke after the same spell writes them (the
//       control that proves the gap machinery in this harness);
//    §4 the built artifact under a PTY that hangs up after the quiet spell:
//       the session shuts down and leaves NO crash record (needs dist/).
//
//  The live legs mount the runtime on fake TTY streams; at exit the
//  runtime's teardown restores fd 1's modes — a few reset bytes after the
//  verdict, harmless.
//
//  Run: bun scripts/ui/prove-teardown-mode-write.ts
// ============================================================================
process.env.NODE_ENV = 'test'

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Readable, Writable } from 'node:stream'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
const SCRATCH = mkdtempSync(join(tmpdir(), 'mercury-teardown-mode-'))
// The runtime records launch milestones in the config home: a scratch home
// keeps the live legs out of the operator's.
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home-live')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const settle = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

// The reader's quiet-spell gap, read from its owner.
const appSrc = readFileSync(join(ROOT, 'src/ink/components/App.tsx'), 'utf8')
const gapMs = Number(/const STDIN_GAP_REASSERT_MS = (\d+)/.exec(appSrc)?.[1])

type Spy = { writes: string[]; errors: string[] }
function fakeTty(): { stdout: NodeJS.WriteStream; spy: Spy } {
  const spy: Spy = { writes: [], errors: [] }
  const stdout = Object.assign(
    new Writable({
      write(chunk: Buffer | string, _enc, cb) {
        spy.writes.push(chunk.toString())
        cb()
      },
    }),
    { columns: 100, rows: 30, isTTY: true },
  ) as unknown as NodeJS.WriteStream
  // A stream error the runtime raises here is a verdict, never a crash of
  // the proof.
  stdout.on('error', (e: Error) => spy.errors.push(e.message))
  return { stdout, spy }
}
function fakeStdin(): NodeJS.ReadStream {
  return Object.assign(new Readable({ read() {} }), {
    isTTY: true,
    setRawMode() {
      return this
    },
    ref() {},
    unref() {},
  }) as unknown as NodeJS.ReadStream
}
const sink = (): Writable => new Writable({ write(_c, _e, cb) { cb() } })

// ── §1 ──────────────────────────────────────────────────────────────────────
section('§1 streamTakesWrites — the one predicate, pure')
{
  const { streamTakesWrites } = await import('../../src/ink/session/delivery.js')
  check('a stream with no verdict flags takes writes', streamTakesWrites({}))
  check('a live Writable takes writes', streamTakesWrites(sink()))
  check('destroyed ⇒ no', !streamTakesWrites({ destroyed: true }))
  check('ended ⇒ no', !streamTakesWrites({ writableEnded: true }))
  check('unwritable ⇒ no', !streamTakesWrites({ writable: false }))
  const ended = sink()
  ended.end()
  check('a Writable after end() ⇒ no', !streamTakesWrites(ended))
  const destroyed = sink()
  destroyed.destroy()
  check('a Writable after destroy() ⇒ no', !streamTakesWrites(destroyed))
}

// ── the live harness ────────────────────────────────────────────────────────
const React = await import('react')
const { render, Text, useInput } = await import('../../src/ink.js')
const instances = (await import('../../src/ink/instances.js')).default
const { EBP, EFE } = await import('../../src/ink/termio/dec.js')
const h = React.createElement as (...a: unknown[]) => React.ReactElement
const isModeWrite = (w: string): boolean => w.includes(EBP) || w.includes(EFE)
function Listener(): React.ReactNode {
  useInput(() => {})
  return h(Text as never, null, 'listening')
}
type Mounted = { unmount: () => void; stdin: NodeJS.ReadStream }
const mounted: Mounted[] = []
async function mount(stdout: NodeJS.WriteStream, stdin: NodeJS.ReadStream): Promise<void> {
  const instance = await render(h(Listener as never, {}), { stdout, stdin, exitOnCtrlC: false, patchConsole: false })
  mounted.push({ unmount: instance.unmount, stdin })
  await settle(80)
}

// ── §2 ──────────────────────────────────────────────────────────────────────
section('§2 the reassert against a torn-down stdout, live')
{
  const { stdout, spy } = fakeTty()
  await mount(stdout, fakeStdin())
  const ink = instances.get(stdout)
  check('the runtime registers the instance under its stdout', ink !== undefined)
  check('the raw-mode arm wrote the mode bytes at mount (the harness sees mode writes)', spy.writes.some(isModeWrite))
  if (ink) {
    spy.writes.length = 0
    ink.reassertTerminalModes()
    await settle(20)
    check('control: a healthy stdout takes the reassert', spy.writes.some(isModeWrite))

    Object.defineProperty(stdout, 'destroyed', { value: true, configurable: true })
    spy.writes.length = 0
    ink.reassertTerminalModes()
    ink.reassertTerminalModes(true)
    await settle(20)
    check('a destroyed stdout takes no mode bytes (the plain and the alt-re-entry arms)', !spy.writes.some(isModeWrite), `${spy.writes.filter(isModeWrite).length} mode writes`)

    Object.defineProperty(stdout, 'destroyed', { value: false, configurable: true })
    Object.defineProperty(stdout, 'writable', { value: false, configurable: true })
    spy.writes.length = 0
    ink.reassertTerminalModes()
    await settle(20)
    check('an unwritable stdout takes no mode bytes', !spy.writes.some(isModeWrite), `${spy.writes.filter(isModeWrite).length} mode writes`)

    Object.defineProperty(stdout, 'writable', { value: true, configurable: true })
    spy.writes.length = 0
    ink.reassertTerminalModes()
    await settle(20)
    check('the same stdout, writable again, takes the reassert (the guard reads the stream, never a latch)', spy.writes.some(isModeWrite))
    check('no stream error was raised', spy.errors.length === 0, spy.errors.join(' | '))
  }
}

// ── §3 ──────────────────────────────────────────────────────────────────────
section('§3 the stdin gap, live — an EOF wake is not a resume')
{
  check('the reader names its quiet-spell gap', Number.isFinite(gapMs) && gapMs > 0, String(gapMs))
  const eof = fakeTty()
  const eofIn = fakeStdin()
  const key = fakeTty()
  const keyIn = fakeStdin()
  await mount(eof.stdout, eofIn)
  await mount(key.stdout, keyIn)
  // The quiet spell: both readers were armed at mount; nothing arrives
  // until the gap has passed.
  await settle(gapMs + 700)
  eof.spy.writes.length = 0
  key.spy.writes.length = 0
  // The hangup: the terminal's EOF wakes the reader with nothing to read.
  eofIn.push(null)
  // A keystroke after the same spell.
  keyIn.push('x')
  await settle(150)
  check('an EOF wake after the quiet spell writes no mode bytes', !eof.spy.writes.some(isModeWrite), `${eof.spy.writes.filter(isModeWrite).length} mode writes`)
  check('control: a keystroke after the quiet spell reasserts the modes', key.spy.writes.some(isModeWrite))
  check('no stream error was raised', eof.spy.errors.length === 0 && key.spy.errors.length === 0, [...eof.spy.errors, ...key.spy.errors].join(' | '))
}

// ── §4 ──────────────────────────────────────────────────────────────────────
section('§4 the built artifact under a PTY that hangs up after the quiet spell')
{
  const BIN = join(ROOT, 'dist/mercury.mjs')
  const { resolveCaptureDriver, vshotBudgetMs } = await import('../lib/captureDriver.js')
  const driver = resolveCaptureDriver()
  check('dist/mercury.mjs is built (this leg drives the artifact)', existsSync(BIN))
  check('a capture driver is available', driver.kind !== 'unavailable', driver.kind === 'unavailable' ? driver.reason : '')
  if (existsSync(BIN) && driver.kind !== 'unavailable') {
    const { sanitizePath } = await import('../../src/utils/sessionStoragePortable.js')
    const { encodeSeedTranscript } = await import('../lib/seedTranscript.js')
    const { seedFirstRun } = await import('../lib/firstRunSeed.js')
    const SID = '00000000-aaaa-bbbb-cccc-e10e10e10e10'
    const home = join(SCRATCH, 'home-pty')
    mkdirSync(home, { recursive: true })
    seedFirstRun(home, [ROOT])
    const projDir = join(home, 'projects', sanitizePath(ROOT))
    mkdirSync(projDir, { recursive: true })
    const lines: Record<string, unknown>[] = []
    let prev: string | null = null
    const base = {
      isSidechain: false, userType: 'external', entrypoint: 'cli',
      cwd: ROOT, sessionId: SID, version: '1.0.0-beta.1', gitBranch: 'main',
    }
    for (let n = 1; n <= 3; n++) {
      const t = String(n).padStart(3, '0')
      const u = `00000000-0000-4000-8000-${String(n * 2).padStart(12, '0')}`
      const a = `00000000-0000-4000-8000-${String(n * 2 + 1).padStart(12, '0')}`
      lines.push({
        ...base, parentUuid: prev, type: 'user', uuid: u,
        message: { role: 'user', content: `TURN-${t} please survey the ledger` },
        timestamp: `2026-06-19T12:00:${String(n * 2).padStart(2, '0')}.000Z`,
      })
      lines.push({
        ...base, parentUuid: u, type: 'assistant', uuid: a, requestId: `req_synth_${t}`,
        message: {
          id: `msg_synth_${t}`, type: 'message', role: 'assistant', model: 'claude-opus-4-8',
          content: [{ type: 'text', text: `TURN-${t} line 01 holds steady.` }],
          stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 50 },
        },
        timestamp: `2026-06-19T12:00:${String(n * 2 + 1).padStart(2, '0')}.000Z`,
      })
      prev = a
    }
    writeFileSync(join(projDir, `${SID}.jsonl`), encodeSeedTranscript(lines, SID))
    const out = join(SCRATCH, 'pty.json')
    const cfgPath = join(SCRATCH, 'pty.cfg.json')
    // No sends: the reader's last activity is its own arm, and the budget
    // outlasts the quiet-spell gap by a wide margin before the driver exits
    // and its side of the PTY closes.
    const total = 55
    writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN, '--resume', SID], cols: 120, rows: 40, total, sends: [], out }))
    const res = spawnSync(driver.python, [join(ROOT, 'scripts/ui/vshot.py'), cfgPath], {
      encoding: 'utf-8',
      cwd: ROOT,
      timeout: vshotBudgetMs(90_000),
      env: {
        ...process.env,
        MERCURY_CONFIG_DIR: home,
        MERCURY_FULLSCREEN: '1',
        MERCURY_DECK_COMPANION: '0',
        MERCURY_CRITTER_IDLE: '0',
        MERCURY_CRITTER_GAZE: '0',
        MERCURY_CRITTER_SLEEP: '0',
        MERCURY_LIVE_CLOCK: '0',
        MERCURY_LIVE_GLYPHS: '0',
        // No turn is ever sent; the API base points at a closed port.
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
      },
    })
    check('the capture ran its budget', res.status === 0, `exit ${res.status}: ${(res.stderr ?? '').trim().slice(-300)}`)
    try {
      const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid: Array<Array<{ c: string }>>; endedAtTick: number }
      const painted = payload.grid.some(row => row.map(c => c.c ?? '').join('').includes('TURN-'))
      check('the resumed session painted before the hangup', painted)
      check('the budget outlasted the quiet-spell gap', payload.endedAtTick * 200 > gapMs + 2000, `ended at tick ${payload.endedAtTick}`)
    } catch (e) {
      check('the capture payload is readable', false, String(e))
    }
    // The driver has exited: its side of the PTY is closed and the
    // session's terminal is gone. The session shuts down, and the
    // supervisor it spawned records its own exit in the spawn ledger.
    const ledger = join(home, 'spawn-ledger.jsonl')
    const deadline = Date.now() + 20_000
    let shutDown = false
    while (Date.now() < deadline) {
      if (existsSync(ledger) && readFileSync(ledger, 'utf8').includes('"event":"exit"')) {
        shutDown = true
        break
      }
      await settle(200)
    }
    check('the session shut down after the hangup (its supervisor recorded an exit)', shutDown, existsSync(ledger) ? readFileSync(ledger, 'utf8').slice(-300) : 'no spawn ledger')
    await settle(600)
    const milestones = existsSync(join(home, 'launch-milestones.json')) ? readFileSync(join(home, 'launch-milestones.json'), 'utf8') : ''
    check('the reader was armed before the hangup (the input-live milestone)', milestones.includes('input-live'))
    const crashDir = join(home, 'crashes')
    const crashes = existsSync(crashDir) ? readdirSync(crashDir) : []
    const described = crashes.map(f => {
      try {
        const j = JSON.parse(readFileSync(join(crashDir, f), 'utf8')) as { message?: string }
        return `${f}: ${j.message ?? ''}`
      } catch {
        return f
      }
    })
    check('the shutdown left no crash record', crashes.length === 0, described.join(' | '))
  }
}

// ── verdict ─────────────────────────────────────────────────────────────────
for (const m of mounted) {
  // The teardown's stdin drain reads only a real terminal.
  Object.defineProperty(m.stdin, 'isTTY', { value: false, configurable: true })
  try {
    m.unmount()
  } catch {
    // The verdict stands on the checks above.
  }
}
if (failures > 0) {
  console.log(`\nteardown-mode-write: RED (${failures} failed) — scratch kept at ${SCRATCH}`)
  process.exit(1)
}
rmSync(SCRATCH, { recursive: true, force: true })
console.log('\nteardown-mode-write: green')
process.exit(0)
