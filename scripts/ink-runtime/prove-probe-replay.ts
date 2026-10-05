import assert from 'node:assert/strict'
import { AnsiEmulator } from './ansiEmulator.ts'

const terminal = new AnsiEmulator(80, 24, true)
terminal.feed('\x1b[3;7H\x1b[31m')
terminal.feed('\x1b7\x1b[8;1Hsample\x1b[6n\x1b[8;1H\x1b[2K\x1b[32m\x1b8X')
assert.equal(terminal.rowText(7), '')
assert.equal(terminal.grid[2]?.[6], 'X')
assert.equal(terminal.styleAt(6, 2)?.fg, '31')
assert.equal(terminal.cursorX, 7)
assert.equal(terminal.cursorY, 2)
assert.throws(() => terminal.feed('\x1b9'), /unknown escape/)
assert.throws(() => terminal.feed('\x1b[7n'), /unknown CSI/)
console.log('PROBE REPLAY HOLDS')
