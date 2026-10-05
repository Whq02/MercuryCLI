import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import React, { useState } from 'react'
import Ink from '../../src/ink/ink.tsx'
import Text from '../../src/ink/components/Text.tsx'
import useInput from '../../src/ink/hooks/use-input.ts'
import instances from '../../src/ink/instances.ts'
import { readFrameTrace, recordFrameTrace, traceKeyResolved, _resetFrameTraceForTesting } from '../../src/ink/root/frame-trace.ts'

class Output extends EventEmitter {
  isTTY = true
  columns = 120
  rows = 40
  writes: Array<{ at: number; bytes: string }> = []
  write(bytes: string): boolean { this.writes.push({ at: performance.now(), bytes }); return true }
}
class Input extends EventEmitter {
  isTTY = true
  isRaw = false
  pending: string | null = null
  get readableLength(): number { return this.pending?.length ?? 0 }
  setEncoding(): this { return this }
  setRawMode(value: boolean): this { this.isRaw = value; return this }
  ref(): this { return this }
  unref(): this { return this }
  read(): string | null { const value = this.pending; this.pending = null; return value }
  send(value: string): void { this.pending = value; this.emit('readable') }
}
let draft = ''
function Scene(): React.ReactElement {
  const [text, setText] = useState('')
  useInput(input => {
    traceKeyResolved(null, ['Chat'])
    draft += input
    setText(draft)
  })
  return React.createElement(Text, null, text || 'ready')
}
const stdout = new Output()
const stdin = new Input()
const ink = new Ink({ stdout: stdout as never, stdin: stdin as never, stderr: new Output() as never, patchConsole: false, exitOnCtrlC: false, onFrame: recordFrameTrace })
instances.set(stdout as never, ink)
ink.render(React.createElement(Scene))
await new Promise(resolve => setTimeout(resolve, 350))
const samples: Array<{ firstMs: number; lastMs: number; bytes: number; frames: number; engineMs: number }> = []
for (const key of ['a', 'b', 'c', 'd', 'e']) {
  _resetFrameTraceForTesting()
  const marker = stdout.writes.length
  const started = performance.now()
  stdin.send(key)
  await new Promise(resolve => setTimeout(resolve, 180))
  const writes = stdout.writes.slice(marker)
  assert.ok(writes.length > 0, 'the real input owner must produce an echo frame')
  const trace = readFrameTrace()
  assert.ok(trace.some(row => row.inputToFrameMs !== null))
  samples.push({ firstMs: writes[0]!.at - started, lastMs: writes[writes.length - 1]!.at - started, bytes: writes.reduce((sum, write) => sum + Buffer.byteLength(write.bytes), 0), frames: trace.length, engineMs: trace.reduce((sum, row) => sum + row.totalMs, 0) })
  const settled = stdout.writes.length
  ink.onRender()
  ink.onRender()
  assert.equal(stdout.writes.length, settled, 'an unchanged settle frame must not write any byte')
}
console.log(JSON.stringify({ samples, cadence: 16 }, null, 2))
console.log('PASS actual key dispatch is attributed by the frame trace and unchanged settle paints write zero bytes')
const exited = ink.waitUntilExit()
ink.unmount()
await exited
console.log('INPUT FRAME TRACE HOLDS')
process.exit(0)
