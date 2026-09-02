#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-open-event-gate.ts — the FIRST-KEY oracle for the
//  open-event seq gate (mercury-feel DoD: "a printable key pressed
//  immediately after opening a palette or search dialog appears exactly
//  once; it is never swallowed and never leaks into the underlying prompt").
//
//  LIVE proof, not a text pin: renders the REAL MercuryCommandPalette under
//  the real ink pipeline (App → stdin 'readable' → parse-keypress →
//  InputEvent → useInput) with a fake PTY-ish stdin, and drives keys:
//
//    1. 'P' opens the palette (host chord). The opener event must NOT seed
//       the palette query (the old stray-'p' class).
//    2. 'q' follows on the very next event — milliseconds later, far inside
//       the old 120ms wall-clock buffer. It MUST land in the query exactly
//       once (the buffer would otherwise swallow it — the fast-first-key bug).
//    3. esc closes immediately (ungated per doctrine).
//
//  Plus the seq-gate unit invariants on currentInputEventSeq().
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-open-event-gate.ts
// ============================================================================
process.env.NODE_ENV = 'test'

import { Readable, Writable } from 'node:stream'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const React = await import('react')
const { render, Box, Text } = await import('../../src/ink.js')
const { default: useInput } = await import('../../src/ink/hooks/use-input.js')
const { MercuryCommandPalette } = await import('../../src/components/MercuryCommandPalette.js')
const { currentInputEventSeq } = await import('../../src/ink/events/input-event.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')

// ── fake terminal ────────────────────────────────────────────────────────────
let written = ''
const stdout = Object.assign(
  new Writable({
    write(chunk: Buffer, _enc, cb) {
      written += chunk.toString()
      cb()
    },
  }),
  { columns: 100, rows: 32, isTTY: false },
) as unknown as NodeJS.WriteStream

const stdin = Object.assign(new Readable({ read() {} }), {
  isTTY: true,
  setRawMode() {},
  ref() {},
  unref() {},
}) as unknown as NodeJS.ReadStream

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
const settle = () => new Promise(r => setTimeout(r, 30))
const press = async (bytes: string) => {
  ;(stdin as unknown as Readable).push(bytes)
  await settle()
}

// ── host: opens the real palette on 'P' (mimics the chord handler) ─────────
const runs: string[] = []
let closedAt = 0
const h = React.createElement as (...a: unknown[]) => React.ReactElement
const FAKE_COMMANDS = [
  { type: 'local', name: 'quokka', description: 'the q command', isEnabled: () => true, isHidden: false },
  { type: 'local', name: 'help', description: 'help', isEnabled: () => true, isHidden: false },
] as never[]

function Host(): React.ReactNode {
  const [open, setOpen] = React.useState(false)
  useInput(
    input => {
      if (input === 'P' && !open) setOpen(true)
    },
    { isActive: !open },
  )
  if (!open) return h(Text as never, {}, 'palette-closed')
  return h(MercuryCommandPalette as never, {
    commands: FAKE_COMMANDS,
    onRun: (t: string) => runs.push(t),
    onClose: () => {
      closedAt = currentInputEventSeq()
      setOpen(false)
    },
  })
}

console.log('prove-open-event-gate — live first-key behavior')
const instance = await render(h(AppStateProvider as never, {}, h(Host as never, {})), {
  stdout,
  stdin,
  exitOnCtrlC: false,
  patchConsole: false,
})

await settle()
const seqBefore = currentInputEventSeq()

// 1. open the palette
written = ''
await press('P')
check('opener event dispatched (seq advanced)', currentInputEventSeq() > seqBefore)
check('palette opened on P', strip(written).includes('run a command'), 'placeholder visible')
check("opener key did NOT leak into the query (no 'P' echo row)", !strip(written).includes('▸ P'))

// 2. the fast first key — the very next event, ~30ms after open (old buffer: 120ms)
written = ''
await press('q')
const frame2 = strip(written)
check("fast first printable landed in the query ('q' filters to quokka)", frame2.includes('quokka'))
check('placeholder replaced (query non-empty)', !frame2.includes('run a command'))
check('it landed exactly once (query row shows single q)', !frame2.includes('qq'))

// 3. esc closes immediately once dispatched (ungated by the gate; the only
//    wait is App's lone-ESC 50ms sequence-disambiguation grace, which is
//    upstream of the gate and applies to every bare ESC everywhere).
written = ''
;(stdin as unknown as Readable).push('\x1b')
// a bare ESC flushes after NORMAL_TIMEOUT + LONE_ESC_GRACE re-arms (~150ms)
await new Promise(r => setTimeout(r, 300))
check('esc closed the palette (no gate in the way)', strip(written).includes('palette-closed'))
check('close observed the esc event itself (no extra wall-clock wait)', closedAt === currentInputEventSeq())

// 4. seq-gate unit invariants
const { currentInputEventSeq: seqFn } = await import('../../src/ink/events/input-event.js')
const a = seqFn()
await press('x') // dispatched to nothing (palette closed, host inactive gate false→true? host reopens on P only)
check('every stdin event bumps the seq exactly once', seqFn() === a + 1, `${a} → ${seqFn()}`)

instance.unmount?.()
console.log(failures === 0 ? '\n✓ prove-open-event-gate: all green' : `\n✗ prove-open-event-gate: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
