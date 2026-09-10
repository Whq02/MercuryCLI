#!/usr/bin/env bun
import { mock } from 'bun:test'
import * as fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'

process.env.MERCURY_CONFIG_DIR = fs.mkdtempSync(join(tmpdir(), 'terminal-pressure-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.NODE_ENV
delete process.env.MERCURY_RENDER_ENGINE
let blocked = false
let allowance = Infinity
let synchronousWaits = 0
let attempts = 0
const accepted: Buffer[] = []
mock.module('node:fs', () => ({
  ...fs,
  writeSync: (fd: number, data: Buffer, offset = 0) => {
    if (fd === 1) return data.length - offset
    if (fd !== 136) throw new Error(`Unexpected terminal descriptor ${fd}`)
    attempts++
    if (blocked || allowance === 0) throw Object.assign(new Error('fixture backpressure'), { code: 'EAGAIN' })
    const count = Math.min(data.length - offset, allowance)
    accepted.push(Buffer.from(data.subarray(offset, offset + count)))
    allowance -= count
    return count
  },
}))
const { default: Ink } = await import('../../src/ink/ink.tsx')
const { Text } = await import('../../src/ink.js')
const { terminalDoor, terminalOwedBytes, termWrite, unbindTerminalDoor } = await import('../../src/render-engine/cockpit/terminalOut.ts')
const { cockpitEngine } = await import('../../src/render-engine/cockpit/engineMount.ts')
const { WriteDoor } = await import('../../src/render-engine/door.ts')
class Output extends EventEmitter {
  isTTY = true
  fd = 136
  columns = 80
  rows = 24
  blocking: boolean[] = []
  _handle = { setBlocking: (value: boolean) => { this.blocking.push(value) } }
  writes: string[] = []
  write(bytes: string): boolean { this.writes.push(bytes); return true }
}
class Input extends EventEmitter {
  isTTY = true
  isRaw = false
  readableLength = 0
  setEncoding(): this { return this }
  setRawMode(raw: boolean): this { this.isRaw = raw; return this }
  ref(): this { return this }
  unref(): this { return this }
  read(): null { return null }
}
let failures = 0
const check = (name: string, ok: boolean): void => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`)
  if (!ok) failures++
}
const output = new Output()
let frames = 0
const ink = new Ink({ stdout: output as never, stderr: new Output() as never, stdin: new Input() as never, patchConsole: false, exitOnCtrlC: false, onFrame: () => { frames++ } })
const originalWait = Atomics.wait
Atomics.wait = (() => { synchronousWaits++; return 'timed-out' }) as typeof Atomics.wait
try {
  ink.render(React.createElement(Text, {}, 'initial frame'))
  ink.onRender()
  check('normal terminal delivery does not enable the optional renderer', cockpitEngine() === null)
  check('a terminal renderer binds the queued output path', terminalDoor(output as never) !== null)
  check('the terminal descriptor is nonblocking while the renderer owns it', output.blocking.at(-1) === false)
  accepted.length = 0
  blocked = false
  allowance = 5
  const first = 'FRAME α\u001b[31m中\u001b[0m END'
  termWrite(output as never, first, 'frame')
  const pending = terminalOwedBytes(output as never)
  check('a partial write retains the precise unwritten suffix', pending === Buffer.byteLength(first) - 5)
  termWrite(output as never, 'MODE-END', 'mode')
  const queued = terminalOwedBytes(output as never)
  const framesBefore = frames
  for (let n = 0; n < 50; n++) ink.onRender()
  check('repeated render requests do not compose or grow a blocked backlog', frames === framesBefore && terminalOwedBytes(output as never) === queued)
  check('backpressure never invokes the synchronous sleep', synchronousWaits === 0)
  const foreign = new Output()
  termWrite(foreign as never, 'FOREIGN')
  unbindTerminalDoor(foreign as never)
  check('a different stream neither uses nor detaches this output channel', foreign.writes.join('') === 'FOREIGN' && terminalDoor(output as never) !== null && terminalOwedBytes(foreign as never) === 0)
  let ticked = false
  await new Promise<void>(resolve => setImmediate(() => { ticked = true; resolve() }))
  check('the event loop handles other work while the terminal is blocked', ticked && terminalOwedBytes(output as never) === queued)
  allowance = Infinity
  const timeout = setTimeout(() => { console.error('terminal drain deadline exceeded'); process.exit(1) }, 2000)
  while (terminalOwedBytes(output as never) > 0) await new Promise(resolve => setTimeout(resolve, 2))
  clearTimeout(timeout)
  const bytes = Buffer.concat(accepted)
  check('partial UTF-8 and mode bytes drain in exact FIFO order', bytes.subarray(0, Buffer.byteLength(first + 'MODE-END')).equals(Buffer.from(first + 'MODE-END')))
  ink.onRender()
  check('painting resumes after the terminal drains', frames > framesBefore)
  ink.enterAlternateScreen()
  check('editor handover drains and restores blocking before returning', terminalOwedBytes(output as never) === 0 && output.blocking.at(-1) === true)
  ink.exitAlternateScreen()
  check('editor return rebinds nonblocking output', output.blocking.at(-1) === false)
} finally {
  blocked = false
  allowance = Infinity
  Atomics.wait = originalWait
  ink.unmount()
}
check('unmount releases the terminal output binding and restores descriptor mode', terminalDoor() === null && output.blocking.at(-1) === true)
let retries = 0
let callback: (() => void) | undefined
let cancelled = false
const queue = new WriteDoor({ tryWrite: () => { retries++; return 'EAGAIN' }, sleepSync: () => {} }, {
  now: () => 0,
  setTimeout: fn => { callback = fn; return 1 },
  clearTimeout: () => { cancelled = true },
})
queue.enqueue({ kind: 'frame', bytes: 'pending' })
queue.dispose()
const attemptsAtDispose = retries
callback?.()
check('disposing a blocked writer cancels retries and releases queued bytes', cancelled && retries === attemptsAtDispose && queue.owedBytes() === 0 && queue.isClosed())
console.log(`terminal-backpressure: ${failures} failure(s), ${attempts} write attempts`)
process.exit(failures === 0 ? 0 : 1)
