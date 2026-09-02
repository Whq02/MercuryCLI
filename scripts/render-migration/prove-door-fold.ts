#!/usr/bin/env bun
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

{
  unbindTerminalDoor()
  const sink: string[] = []
  const stream = makeStream(sink)
  termWrite(stream, 'MODE-A', 'mode')
  termWrite(stream, 'BELL', 'bell')
  check('D1 unbound: bytes reach the stream directly, in order', sink.join('|') === 'MODE-A|BELL', sink.join('|'))
  check('D1 unbound: owed is 0', terminalOwedBytes() === 0)
}

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
  stream.fd = 99
  bindTerminalDoor(stream, syscalls)

  const delivered = writeDiffToTerminal(
    { stdout: stream, stderr: makeStream([]) },
    [{ type: 'stdout', content: 'FRAME-ONE' }],
    true,
  )
  termWrite(stream, 'MODE-B', 'mode')
  check('D2 the frame seam reports delivered (whole-unit FIFO construction)', delivered === true)
  check('D4 owed counts both queued units while the kernel refuses', terminalOwedBytes() === 'FRAME-ONE'.length + 'MODE-B'.length, String(terminalOwedBytes()))
  check('D2 nothing bypassed the door onto the stream', sink.length === 0, JSON.stringify(sink))

  refuse = false
  acceptBudget = 4
  const drained = flushDoorSync()
  check('D6 flushDoorSync drains within budget', drained === true)
  check('D3 the concatenated stream equals the concatenation of whole units, in order', accepted.join('') === 'FRAME-ONEMODE-B', accepted.join(''))
  check('D4 owed returns to 0 after the drain', terminalOwedBytes() === 0)

  const stderrSink: string[] = []
  const stderr = makeStream(stderrSink)
  termWrite(stderr, 'STDERR-DIRECT', 'mode')
  check('D5 a stream other than the bound one writes directly', stderrSink.join('') === 'STDERR-DIRECT')

  unbindTerminalDoor()
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
