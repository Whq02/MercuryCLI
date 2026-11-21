import assert from 'node:assert/strict'
import { AnsiEmulator } from './ansiEmulator.ts'

const terminal = new AnsiEmulator(80, 24, true)
terminal.feed('\x1b[3;7H\x1b[31m')
terminal.feed('\x1b7\x1b[8;1Hsample\x1b[6n\x1b[8;1H\x1b[2K\x1b[32m\x1b8X')
assert.equal(terminal.rowText(7), '', 'row 8 should be empty after the replayed \\x1b[2K; fix the erase-line handling in AnsiEmulator (scripts/ink-runtime/ansiEmulator.ts)')
assert.equal(terminal.grid[2]?.[6], 'X', 'X should land at the cursor saved by \\x1b7 (row 3, column 7) after \\x1b8; fix the save/restore cursor handling in AnsiEmulator (scripts/ink-runtime/ansiEmulator.ts)')
assert.equal(terminal.styleAt(6, 2)?.fg, '31', 'the style saved by \\x1b7 (red, 31) should be restored by \\x1b8; fix the save/restore handling in AnsiEmulator (scripts/ink-runtime/ansiEmulator.ts)')
assert.equal(terminal.cursorX, 7, 'cursor column should be 7 after printing X at the restored position; fix AnsiEmulator (scripts/ink-runtime/ansiEmulator.ts)')
assert.equal(terminal.cursorY, 2, 'cursor row should be 2 after the restored print; fix AnsiEmulator (scripts/ink-runtime/ansiEmulator.ts)')
assert.throws(() => terminal.feed('\x1b9'), /unknown escape/, 'AnsiEmulator (scripts/ink-runtime/ansiEmulator.ts) must throw "unknown escape" for an escape it does not implement, not skip it')
assert.throws(() => terminal.feed('\x1b[7n'), /unknown CSI/, 'AnsiEmulator (scripts/ink-runtime/ansiEmulator.ts) must throw "unknown CSI" for a device-status request other than 6n, not skip it')
console.log('PROBE REPLAY HOLDS')
