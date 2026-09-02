#!/usr/bin/env bun

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

if (flagEnv('MERCURY_RENDER_ENGINE') === undefined) setFlagEnv('MERCURY_RENDER_ENGINE', '1')
if (!renderEngineEnabled()) {
  console.error('demo-surface: MERCURY_RENDER_ENGINE gate is off — refusing to run')
  process.exit(2)
}

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
  chokeHighWaterBytes: 16 * 1024,
  onFlatnessViolation: (identity, seq) => {
    console.error(`FLATNESS VIOLATION: ${identity} in batch ${seq}`)
    process.exitCode = 3
  },
})


let seed = 0x6d657263
const rand = (): number => {
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
timers.push(
  setInterval(() => {
    spin++
    engine.updateTail(tail())
  }, 100),
)
timers.push(
  setInterval(() => {
    typed = typed.length > 24 ? '' : typed + 'aeimnoprst'[Math.floor(rand() * 10)]!
    engine.noteKeystroke(tail())
  }, 90),
)
timers.push(
  setInterval(() => {
    frameTick++
    engine.updateTail(tail())
  }, 1000),
)
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
