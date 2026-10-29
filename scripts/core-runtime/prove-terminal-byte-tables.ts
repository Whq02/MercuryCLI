#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import assert from 'node:assert/strict'
import { BEL, C0, ESC, ESC_TYPE, SEP, isEscFinal } from '../../src/ink/termio/ansi.js'
import {
  CSI,
  CURSOR_HOME,
  CURSOR_STYLES,
  DISABLE_KITTY_KEYBOARD,
  DISABLE_MODIFY_OTHER_KEYS,
  ENABLE_KITTY_KEYBOARD,
  ENABLE_MODIFY_OTHER_KEYS,
  ERASE_DISPLAY,
  ERASE_LINE_REGION,
  ERASE_SCREEN,
  ERASE_SCROLLBACK,
  FOCUS_IN,
  FOCUS_OUT,
  PASTE_END,
  PASTE_START,
  RESET_SCROLL_REGION,
  csi,
  cursorBack,
  cursorDown,
  cursorForward,
  cursorMove,
  cursorPosition,
  cursorTo,
  cursorUp,
  eraseLines,
  eraseToEndOfLine,
  eraseToEndOfScreen,
  isCSIFinal,
  isCSIIntermediate,
  isCSIParam,
  scrollDown,
  scrollUp,
  setScrollRegion,
} from '../../src/ink/termio/csi.js'
import { defaultStyle } from '../../src/ink/termio/display-types.js'
import { CLEAR_ITERM2_PROGRESS, CLEAR_TERMINAL_TITLE } from '../../src/ink/termio/osc.js'

let failures = 0
let checks = 0
function check(label: string, run: () => void): void {
  checks++
  try {
    run()
    console.log(`  [PASS] ${label}`)
  } catch (error) {
    failures++
    console.log(`  [FAIL] ${label} — ${String(error instanceof Error ? error.message : error).split('\n')[0]}`)
  }
}

const E = '\x1b'

console.log('§1 the control bytes')
check('the C0 table is the 32 ASCII control mnemonics in order plus DEL', () => {
  const expected = {
    NUL: 0x00, SOH: 0x01, STX: 0x02, ETX: 0x03, EOT: 0x04, ENQ: 0x05, ACK: 0x06, BEL: 0x07,
    BS: 0x08, HT: 0x09, LF: 0x0a, VT: 0x0b, FF: 0x0c, CR: 0x0d, SO: 0x0e, SI: 0x0f,
    DLE: 0x10, DC1: 0x11, DC2: 0x12, DC3: 0x13, DC4: 0x14, NAK: 0x15, SYN: 0x16, ETB: 0x17,
    CAN: 0x18, EM: 0x19, SUB: 0x1a, ESC: 0x1b, FS: 0x1c, GS: 0x1d, RS: 0x1e, US: 0x1f, DEL: 0x7f,
  }
  assert.deepEqual({ ...C0 }, expected)
})
check('ESC, BEL and the parameter separator', () => {
  assert.equal(ESC, E)
  assert.equal(BEL, '\x07')
  assert.equal(SEP, ';')
})
check('the byte after ESC names the escape family', () => {
  assert.deepEqual({ ...ESC_TYPE }, { CSI: 0x5b, OSC: 0x5d, DCS: 0x50, APC: 0x5f, PM: 0x5e, SOS: 0x58, ST: 0x5c })
})
check('an ESC final byte is 0x30..0x7e and nothing beside', () => {
  assert.equal(isEscFinal(0x2f), false)
  assert.equal(isEscFinal(0x30), true)
  assert.equal(isEscFinal(0x7e), true)
  assert.equal(isEscFinal(0x7f), false)
  assert.equal(isEscFinal(-1), false)
})
check('the CSI byte classes: parameters 0x30..0x3f, intermediates 0x20..0x2f, finals 0x40..0x7e', () => {
  assert.deepEqual([isCSIParam(0x2f), isCSIParam(0x30), isCSIParam(0x3f), isCSIParam(0x40)], [false, true, true, false])
  assert.deepEqual([isCSIIntermediate(0x1f), isCSIIntermediate(0x20), isCSIIntermediate(0x2f), isCSIIntermediate(0x30)], [false, true, true, false])
  assert.deepEqual([isCSIFinal(0x3f), isCSIFinal(0x40), isCSIFinal(0x7e), isCSIFinal(0x7f)], [false, true, true, false])
})

console.log('§2 the CSI final-byte table and the parser tables')
check('every CSI mnemonic maps to its final byte', () => {
  assert.deepEqual({ ...CSI }, {
    CUU: 0x41, CUD: 0x42, CUF: 0x43, CUB: 0x44, CNL: 0x45, CPL: 0x46, CHA: 0x47, CUP: 0x48, CHT: 0x49,
    ED: 0x4a, EL: 0x4b, IL: 0x4c, DL: 0x4d, DCH: 0x50, SU: 0x53, SD: 0x54, ECH: 0x58, CBT: 0x5a,
    ICH: 0x40, VPA: 0x64, HVP: 0x66, SM: 0x68, RM: 0x6c, SGR: 0x6d, DSR: 0x6e,
    DECSCUSR: 0x71, DECSTBM: 0x72, SCOSC: 0x73, SCORC: 0x75,
  })
})
check('the erase regions in parameter order', () => {
  assert.deepEqual([...ERASE_DISPLAY], ['toEnd', 'toStart', 'all', 'scrollback'])
  assert.deepEqual([...ERASE_LINE_REGION], ['toEnd', 'toStart', 'all'])
})
check('DECSCUSR 0..6: a blinking block, then block, underline and bar each blinking then steady', () => {
  assert.deepEqual(CURSOR_STYLES, [
    { style: 'block', blinking: true },
    { style: 'block', blinking: true },
    { style: 'block', blinking: false },
    { style: 'underline', blinking: true },
    { style: 'underline', blinking: false },
    { style: 'bar', blinking: true },
    { style: 'bar', blinking: false },
  ])
})

console.log('§3 the generators, byte for byte')
check('csi(): the bare introducer, one body, and parameters joined before a final', () => {
  assert.equal(csi(), `${E}[`)
  assert.equal(csi('H'), `${E}[H`)
  assert.equal(csi('200~'), `${E}[200~`)
  assert.equal(csi(3, 'A'), `${E}[3A`)
  assert.equal(csi(2, 7, 'H'), `${E}[2;7H`)
  assert.equal(csi('>', 4, 2, 'm'), `${E}[>;4;2m`)
})
check('the six counted sequences: a count of 0 is empty, the default is 1, a negative count is written as given', () => {
  const table: Array<[(n?: number) => string, string]> = [
    [cursorUp, 'A'], [cursorDown, 'B'], [cursorForward, 'C'], [cursorBack, 'D'], [scrollUp, 'S'], [scrollDown, 'T'],
  ]
  for (const [sequence, final] of table) {
    assert.equal(sequence(0), '')
    assert.equal(sequence(), `${E}[1${final}`)
    assert.equal(sequence(1), `${E}[1${final}`)
    assert.equal(sequence(12), `${E}[12${final}`)
    assert.equal(sequence(-2), `${E}[-2${final}`)
  }
})
check('cursorTo, cursorPosition and the home sequence', () => {
  assert.equal(cursorTo(1), `${E}[1G`)
  assert.equal(cursorTo(40), `${E}[40G`)
  assert.equal(cursorPosition(3, 9), `${E}[3;9H`)
  assert.equal(CURSOR_HOME, `${E}[H`)
})
check('cursorMove writes the horizontal part first, then the vertical, each omitted at zero', () => {
  assert.equal(cursorMove(0, 0), '')
  assert.equal(cursorMove(3, 0), `${E}[3C`)
  assert.equal(cursorMove(-3, 0), `${E}[3D`)
  assert.equal(cursorMove(0, 2), `${E}[2B`)
  assert.equal(cursorMove(0, -2), `${E}[2A`)
  assert.equal(cursorMove(4, -1), `${E}[4C${E}[1A`)
  assert.equal(cursorMove(-4, 5), `${E}[4D${E}[5B`)
})
check('the erase family', () => {
  assert.equal(eraseToEndOfLine(), `${E}[K`)
  assert.equal(eraseToEndOfScreen(), `${E}[J`)
  assert.equal(ERASE_SCREEN, `${E}[2J`)
  assert.equal(ERASE_SCROLLBACK, `${E}[3J`)
})
check('eraseLines: nothing for 0 or less; whole-line erases with a cursor-up between each pair, then column 1', () => {
  assert.equal(eraseLines(0), '')
  assert.equal(eraseLines(-3), '')
  assert.equal(eraseLines(1), `${E}[2K${E}[G`)
  assert.equal(eraseLines(2), `${E}[2K${E}[1A${E}[2K${E}[G`)
  assert.equal(eraseLines(3), `${E}[2K${E}[1A${E}[2K${E}[1A${E}[2K${E}[G`)
})
check('the scroll region pair', () => {
  assert.equal(setScrollRegion(2, 20), `${E}[2;20r`)
  assert.equal(RESET_SCROLL_REGION, `${E}[r`)
})
check('the terminal-to-application markers', () => {
  assert.equal(PASTE_START, `${E}[200~`)
  assert.equal(PASTE_END, `${E}[201~`)
  assert.equal(FOCUS_IN, `${E}[I`)
  assert.equal(FOCUS_OUT, `${E}[O`)
})
check('the keyboard protocol switches', () => {
  assert.equal(ENABLE_KITTY_KEYBOARD, `${E}[>5u`)
  assert.equal(DISABLE_KITTY_KEYBOARD, `${E}[<u`)
  assert.equal(ENABLE_MODIFY_OTHER_KEYS, `${E}[>4;2m`)
  assert.equal(DISABLE_MODIFY_OTHER_KEYS, `${E}[>4m`)
})

console.log('§4 the display parser\'s default style and the exit cleanups')
check('defaultStyle is every attribute off, no underline, three default colours — a fresh record and fresh colours per call', () => {
  const one = defaultStyle()
  assert.deepEqual(one, {
    bold: false, dim: false, italic: false, blink: false, inverse: false, hidden: false, strikethrough: false, overline: false,
    underline: 'none', fg: { type: 'default' }, bg: { type: 'default' }, underlineColor: { type: 'default' },
  })
  const two = defaultStyle()
  assert.notEqual(one, two)
  assert.notEqual(one.fg, two.fg)
})
check('the exit-path cleanups are BEL-terminated OSC sequences', () => {
  assert.equal(CLEAR_ITERM2_PROGRESS, `${E}]9;4;0;\x07`)
  assert.equal(CLEAR_TERMINAL_TITLE, `${E}]0;\x07`)
})

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(` ✅ TERMINAL BYTE TABLES GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ TERMINAL BYTE TABLES RED (${failures} of ${checks} checks failed)`)
process.exit(1)
