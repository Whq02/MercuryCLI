import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import React from 'react'
import Ink from '../../src/ink/ink.tsx'
import Text from '../../src/ink/components/Text.tsx'
import { AlternateScreen } from '../../src/ink/components/AlternateScreen.tsx'
import useInput from '../../src/ink/hooks/use-input.ts'
import instances from '../../src/ink/instances.ts'
import { AnsiEmulator } from './ansiEmulator.ts'

class Output extends EventEmitter {
  isTTY = true
  columns = 120
  rows = 40
  writes: string[] = []
  write(value: string): boolean { this.writes.push(value); return true }
}
class Input extends EventEmitter {
  isTTY = true
  isRaw = false
  readableLength = 0
  setEncoding(): this { return this }
  setRawMode(value: boolean): this { this.isRaw = value; return this }
  ref(): this { return this }
  unref(): this { return this }
  read(): null { return null }
}
function Scene(): React.ReactElement {
  useInput(() => {})
  return React.createElement(Text, null, 'probe paint complete')
}

const stdout = new Output()
let redraws = 0
let frames = 0
let finish: () => void = () => {}
const repainted = new Promise<void>(resolve => { finish = resolve })
const ink = new Ink({
  stdout: stdout as never,
  stdin: new Input() as never,
  stderr: new Output() as never,
  patchConsole: false,
  exitOnCtrlC: false,
  onFrame: () => {
    frames++
    if (redraws > 0) finish()
  },
})
instances.set(stdout as never, ink)
const redraw = ink.forceRedraw.bind(ink)
ink.forceRedraw = () => { redraws++; redraw() }
ink.render(React.createElement(AlternateScreen, null, React.createElement(Scene)))
const timeout = setTimeout(() => { console.error('FAIL the width probe never forced its cleanup paint'); process.exit(1) }, 5000)
await repainted
clearTimeout(timeout)
assert.equal(redraws, 1)
assert.ok(frames >= 1)
assert.equal(ink.isAltScreenActive, true, 'FAIL the boot road arms raw mode inside the alternate screen')
const queryWrite = stdout.writes.find(value => value.includes('\x1b[6n'))
assert.ok(queryWrite, 'FAIL the mounted input owner must queue the width probe in its real startup batch')
assert.equal((queryWrite.match(/\x1b\[6n/g) ?? []).length, 8)
assert.equal((queryWrite.match(/\x1b\[c/g) ?? []).length, 1)
assert.ok(queryWrite.indexOf('\x1b[?u') >= 0 && queryWrite.indexOf('\x1b[?u') < queryWrite.indexOf('\x1b[6n'), `FAIL the kitty query rode before the samples — kitty at ${queryWrite.indexOf('\x1b[?u')}, first CPR at ${queryWrite.indexOf('\x1b[6n')}`)
const cells = new AnsiEmulator(120, 40, true)
for (const sample of queryWrite.matchAll(/\x1b7([\s\S]*?)\x1b8/g)) {
  cells.feed(sample[1]!.replaceAll('\x1b[6n', ''))
}
for (let row = 1; row <= 8; row++) assert.equal(cells.rowText(row), '')
const lastClear = stdout.writes.findLastIndex(value => value.includes('\x1b[2J'))
assert.ok(lastClear >= 0)
for (const write of stdout.writes.slice(lastClear)) cells.feed(write)
assert.ok(cells.rowText(0).includes('probe paint complete'))
for (let row = 1; row <= 8; row++) assert.equal(cells.rowText(row), '')
console.log('PASS all eight sample rows are blank after the actual input owner forces one cleanup repaint on the alternate screen')
console.log('PASS unanswered capability queries cannot leave the samples on screen')
const exited = ink.waitUntilExit()
ink.unmount()
await exited

const inlineStdout = new Output()
let inlineRedraws = 0
const inlineInk = new Ink({
  stdout: inlineStdout as never,
  stdin: new Input() as never,
  stderr: new Output() as never,
  patchConsole: false,
  exitOnCtrlC: false,
})
instances.set(inlineStdout as never, inlineInk)
const inlineRedraw = inlineInk.forceRedraw.bind(inlineInk)
inlineInk.forceRedraw = () => { inlineRedraws++; inlineRedraw() }
inlineInk.render(React.createElement(Scene))
await new Promise(resolve => setTimeout(resolve, 400))
assert.equal(inlineInk.isAltScreenActive, false)
assert.equal(inlineRedraws, 0, 'FAIL an inline arm must never repaint for the probe')
assert.ok(!inlineStdout.writes.some(value => value.includes('\x1b[6n')), 'FAIL an inline arm must not send CPR samples')
assert.ok(!inlineStdout.writes.some(value => value.includes('\x1b7')), 'FAIL an inline arm must not touch the primary screen')
const inlineExited = inlineInk.waitUntilExit()
inlineInk.unmount()
await inlineExited
console.log('PASS an inline (primary-screen) arm writes no sample bytes and no cleanup repaint')
console.log('WIDTH PROBE PAINT HOLDS')
process.exit(0)
