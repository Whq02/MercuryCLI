#!/usr/bin/env bun
// ============================================================================
//  demo-surface — the spinner/tool-card surface driven by the render engine.
//
//  The junk-bytes acceptance runs THIS surface on an Apple-Terminal-like
//  capability profile (probe withheld ⇒ sync off ⇒ zero 2026 bytes; no kitty
//  push — the engine has no kitty vocabulary at all) under a slow-drain PTY
//  recorder for 30+ minutes; the capture must parse byte-for-byte clean.
//
//  The drive is deterministic: a seeded stream of prose settles into turns
//  while a tool card spins at 10Hz, the composer echoes scripted keystrokes,
//  a status strip ticks once a second, and a picker overlay composites over
//  the tail periodically. All content stays inside the declared demo
//  alphabet so the verifier can flag ANY stray printable.
//
//  Flag law: the demo constructs an engine, so it runs with
//  MERCURY_RENDER_ENGINE=1 stamped through the registry writer and refuses
//  to run with the gate off — the flag is load-bearing, mechanically.
// ============================================================================

import {
  RenderEngine,
  StreamBodyCache,
  ttySyscalls,
  type TailInput,
} from '../../src/render-engine/index.js'
import { renderEngineEnabled } from '../../src/render-engine/flag.js'
import { flagEnv, setFlagEnv } from '../../src/substrate/flagRegistry.js'

const args = process.argv.slice(2)
const argOf = (name: string, fallback: string): string => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback
}
const DURATION_MS = Number(argOf('--duration-ms', '60000'))
const COLS = Number(process.env.COLUMNS ?? argOf('--cols', '80'))
const ROWS = Number(process.env.LINES ?? argOf('--rows', '24'))

// The demo arms the gate for itself, but an operator's explicit pin wins:
// a forced '0' refuses to run — the flag is load-bearing, mechanically.
if (flagEnv('MERCURY_RENDER_ENGINE') === undefined) setFlagEnv('MERCURY_RENDER_ENGINE', '1')
if (!renderEngineEnabled()) {
  console.error('demo-surface: MERCURY_RENDER_ENGINE gate is off — refusing to run')
  process.exit(2)
}

// Raw stdin on a TTY shares the open file description with stdout and makes
// it non-blocking — the production condition the door's EAGAIN pump exists
// for. Input bytes are consumed and dropped (the Apple-class profile never
// answers probes; the recorder sends no keys).
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.on('data', () => {})
}

const engine = new RenderEngine({
  syscalls: ttySyscalls(1),
  viewport: { cols: COLS, rows: ROWS },
  profile: {
    syncOutput: false,
    syncWhy: 'profile withholds the probe (Apple-Terminal capability class)',
  },
  // The Apple-class profile drains slowly; a tight choke bound keeps frames
  // fresh (E6's law at this terminal's scale — the default stays order
  // 256KB).
  chokeHighWaterBytes: 16 * 1024,
  onFlatnessViolation: (identity, seq) => {
    // A fixture drive treats a flatness drop as a loud stop.
    console.error(`FLATNESS VIOLATION: ${identity} in batch ${seq}`)
    process.exitCode = 3
  },
})

// ── deterministic content ───────────────────────────────────────────────────

let seed = 0x6d657263 // 'merc'
const rand = (): number => {
  // xorshift32 — deterministic across runs.
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  seed >>>= 0
  return seed / 0xffffffff
}

const WORDS =
  `the paint engine settles a row once and never rewrites it
   every byte leaves through one door in whole units
   a slow terminal receives fewer fresher frames
   the live tail stays bounded and complete
   resize is a storm with one settled end
   transient surfaces never touch settled history
   time does not degrade the engine`.split(/\s+/)

const word = (): string => WORDS[Math.floor(rand() * WORDS.length)]!

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const CYAN = '\x1b[36m'
const RESET = '\x1b[0m'

const wrapPlain = (text: string, width: number): string[] => {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const w of para.split(/\s+/).filter(Boolean)) {
      if (line.length + w.length + 1 > width - 2) {
        out.push(line)
        line = w
      } else {
        line = line === '' ? w : line + ' ' + w
      }
    }
    out.push(line)
  }
  return out
}

// ── the drive ───────────────────────────────────────────────────────────────

const stream = new StreamBodyCache((text, width) => wrapPlain(text, width))
let body = ''
let turn = 0
let spin = 0
let toolStartedAt = Date.now()
let typed = ''
let frameTick = 0
let overlayOpen = false

const tail = (): Partial<TailInput> => {
  const streamRows =
    body === ''
      ? []
      : stream.update(body, COLS).rows.map(r => ' ' + r)
  const elapsed = ((Date.now() - toolStartedAt) / 1000).toFixed(1)
  const toolRows = [
    `${DIM}╭─ tool ───────────────╮${RESET}`,
    `${DIM}│${RESET} ${CYAN}${SPINNER[spin % SPINNER.length]}${RESET} probing terminal ${DIM}${elapsed}s${RESET}`,
    `${DIM}╰──────────────────────╯${RESET}`,
  ]
  const composerRows = [`${BOLD}❯${RESET} ${typed}`]
  const statusRows = [`${DIM}· engine demo · turn ${turn} · tick ${frameTick} ·${RESET}`]
  return {
    streamRows,
    toolRows,
    composerRows,
    statusRows,
    cursor: { rowOffset: 0, col: 2 + typed.length },
  }
}

const timers: ReturnType<typeof setInterval>[] = []

// The streaming turn: ~28 chunks/s; settles every 2.5-4s.
timers.push(
  setInterval(() => {
    body += (body === '' || rand() < 0.12 ? '' : ' ') + word()
    if (rand() < 0.02) body += '\n\n'
    engine.updateTail(tail())
  }, 36),
)
timers.push(
  setInterval(() => {
    if (body === '') return
    turn++
    const lines = [
      `${BOLD}· turn ${turn}${RESET}`,
      ...wrapPlain(body, COLS).map(r => '  ' + r),
      '',
    ]
    const ack = engine.submitSettled({
      seq: engine.nextSeq(),
      widthEpoch: engine.widthEpoch(),
      rows: [{ identity: `turn-${turn}`, lines }],
    })
    if (ack.kind !== 'accepted') {
      console.error(`unexpected ack ${ack.kind} for turn ${turn}`)
      process.exitCode = 3
    }
    body = ''
    stream.reset()
    toolStartedAt = Date.now()
    engine.updateTail(tail())
  }, 2500 + Math.floor(rand() * 1500)),
)
// The spinner: 10Hz.
timers.push(
  setInterval(() => {
    spin++
    engine.updateTail(tail())
  }, 100),
)
// Composer echo: scripted typing on the keystroke lane.
timers.push(
  setInterval(() => {
    typed = typed.length > 24 ? '' : typed + 'aeimnoprst'[Math.floor(rand() * 10)]!
    engine.noteKeystroke(tail())
  }, 90),
)
// Status tick.
timers.push(
  setInterval(() => {
    frameTick++
    engine.updateTail(tail())
  }, 1000),
)
// A picker overlay composites over the tail every ~20s for 2s (E8's
// non-fullscreen path — history bytes stay untouched).
timers.push(
  setInterval(() => {
    if (overlayOpen) return
    overlayOpen = true
    engine.openOverlay({
      fullscreen: false,
      rows: [
        `${DIM}╭─ picker ─────────────╮${RESET}`,
        `${DIM}│${RESET} ${BOLD}one${RESET}  two  three      ${DIM}│${RESET}`,
        `${DIM}╰──────────────────────╯${RESET}`,
      ],
    })
    setTimeout(() => {
      overlayOpen = false
      engine.closeOverlay()
    }, 2000)
  }, 20000),
)

let finishing = false
const finish = (): void => {
  if (finishing) return
  finishing = true
  for (const t of timers) clearInterval(t)
  // Drain the door before teardown: a slow terminal is owed the queued
  // frames, and the restore unit must land WHOLE — the capture ends on a
  // unit boundary, never inside an escape.
  const drainDeadline = Date.now() + 120_000
  const awaitDrain = (): void => {
    if (engine.doorRef().owedBytes() > 0 && Date.now() < drainDeadline) {
      setTimeout(awaitDrain, 100)
      return
    }
    engine.detach()
    process.exit(process.exitCode ?? 0)
  }
  awaitDrain()
}
setTimeout(finish, DURATION_MS)
process.on('SIGTERM', finish)
process.on('SIGINT', finish)

engine.updateTail(tail())
