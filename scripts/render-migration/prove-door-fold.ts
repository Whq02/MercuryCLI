#!/usr/bin/env bun
// ============================================================================
//  scripts/render-migration/prove-door-fold.ts — the second write path folds
//  into the ONE door (E4 at the cockpit seam).
//
//  D1  UNBOUND (flag off): termWrite writes to the given stream directly —
//      byte-identical classic behaviour; owed is always 0.
//  D2  BOUND: frames (via writeDiffToTerminal) and mode/probe/bell bytes
//      (via termWrite) leave through ONE FIFO in enqueue order — a mode
//      toggle enqueued mid-frame-backlog cannot interleave into the frame.
//  D3  WHOLE UNITS under EAGAIN: a partially-accepted frame's remainder is
//      delivered before the first byte of the next unit.
//  D4  owedBytes() is the drain truth while the kernel refuses.
//  D5  a stream OTHER than the bound one keeps writing directly (stderr).
//  D6  flushDoorSync drains within the budget (the teardown restore path).
//
//  Run: ~/.bun/bin/bun run scripts/render-migration/prove-door-fold.ts
// ============================================================================
import { Writable } from 'node:stream'
import {
  bindTerminalDoor,
  flushDoorSync,
  terminalOwedBytes,
  termWrite,
  unbindTerminalDoor,
} from '../../src/render-engine/cockpit/terminalOut.ts'
import { writeDiffToTerminal } from '../../src/ink/session/delivery.ts'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

function makeStream(sink: string[]): Writable & { isTTY?: boolean; fd?: number } {
  const s = new Writable({
    write(chunk, _enc, cb) {
      sink.push(String(chunk))
      cb()
    },
  }) as Writable & { isTTY?: boolean; fd?: number }
  return s
}

console.log('door fold laws')

// ── D1: unbound identity ───────────────────────────────────────────────────
{
  unbindTerminalDoor()
  const sink: string[] = []
  const stream = makeStream(sink)
  termWrite(stream, 'MODE-A', 'mode')
  termWrite(stream, 'BELL', 'bell')
  check('D1 unbound: bytes reach the stream directly, in order', sink.join('|') === 'MODE-A|BELL', sink.join('|'))
  check('D1 unbound: owed is 0', terminalOwedBytes() === 0)
}

// ── D2/D3/D4: bound FIFO, whole units under EAGAIN ─────────────────────────
{
  const accepted: string[] = []
  let refuse = true
  let acceptBudget = 0
  const syscalls = {
    tryWrite(bytes: Buffer): number | 'EAGAIN' | 'closed' {
      if (refuse) return 'EAGAIN'
      const n = Math.min(bytes.length, acceptBudget > 0 ? acceptBudget : bytes.length)
      if (n === 0) return 'EAGAIN'
      accepted.push(bytes.subarray(0, n).toString('utf8'))
      return n
    },
    sleepSync(): void {},
  }
  const sink: string[] = []
  const stream = makeStream(sink)
  stream.isTTY = true
  stream.fd = 99 // never written: the test syscalls own delivery
  bindTerminalDoor(stream, syscalls)

  // A frame goes through writeDiffToTerminal's door seam...
  const delivered = writeDiffToTerminal(
    { stdout: stream, stderr: makeStream([]) },
    [{ type: 'stdout', content: 'FRAME-ONE' }],
    true,
  )
  // ...and a mode toggle lands BEHIND it while the kernel refuses.
  termWrite(stream, 'MODE-B', 'mode')
  check('D2 the frame seam reports delivered (whole-unit FIFO construction)', delivered === true)
  check('D4 owed counts both queued units while the kernel refuses', terminalOwedBytes() === 'FRAME-ONE'.length + 'MODE-B'.length, String(terminalOwedBytes()))
  check('D2 nothing bypassed the door onto the stream', sink.length === 0, JSON.stringify(sink))

  // Drain with a 4-byte kernel budget per accept: units must come out whole
  // and in order even though every accept is partial.
  refuse = false
  acceptBudget = 4
  const drained = flushDoorSync()
  check('D6 flushDoorSync drains within budget', drained === true)
  check('D3 the concatenated stream equals the concatenation of whole units, in order', accepted.join('') === 'FRAME-ONEMODE-B', accepted.join(''))
  check('D4 owed returns to 0 after the drain', terminalOwedBytes() === 0)

  // ── D5: a foreign stream stays direct ────────────────────────────────────
  const stderrSink: string[] = []
  const stderr = makeStream(stderrSink)
  termWrite(stderr, 'STDERR-DIRECT', 'mode')
  check('D5 a stream other than the bound one writes directly', stderrSink.join('') === 'STDERR-DIRECT')

  unbindTerminalDoor()
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
