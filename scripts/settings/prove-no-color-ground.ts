import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'no-color-ground-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.NO_COLOR = '1'
process.env.TERM = 'xterm-256color'
delete process.env.FORCE_COLOR
delete process.env.MERCURY_HOME
const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
try {
  const bg = await import('../../src/screen/cockpit/oasisBg.ts')
  const out: string[] = []
  const write = (text: string) => { out.push(text) }
  bg._resetGroundForTest()
  bg.syncOasisBgToTheme('dark', write)
  assert.equal(out.join(''), '', 'NO_COLOR plus a dark theme writes no OSC 11; change syncOasisBgToTheme in src/screen/cockpit/oasisBg.ts to write nothing when NO_COLOR is set')
  bg.markOriginalGroundQuerySent()
  bg.noteOriginalGroundReply('#123456', write)
  assert.equal(out.join(''), '', 'the warm acquisition cannot bypass NO_COLOR; change noteOriginalGroundReply in src/screen/cockpit/oasisBg.ts to honour the same NO_COLOR gate')
  delete process.env.NO_COLOR
  process.env.TERM = 'dumb'
  bg.syncOasisBgToTheme('dark', write)
  assert.equal(out.join(''), '', 'TERM=dumb writes no OSC 11; change syncOasisBgToTheme in src/screen/cockpit/oasisBg.ts to write nothing for a dumb terminal')
  process.env.TERM = 'xterm-256color'
  bg.syncOasisBgToTheme('mono', write)
  assert.equal(out.join(''), '', 'Black and white writes no OSC 11; change syncOasisBgToTheme in src/screen/cockpit/oasisBg.ts to write nothing for the mono theme')
  bg.syncOasisBgToTheme('dark', write)
  assert.ok(out.join('').includes('\x1b]11;'), 'the control case paints the dark ground; syncOasisBgToTheme in src/screen/cockpit/oasisBg.ts must write OSC 11 for the dark theme when colour is allowed')
  out.length = 0
  process.env.NO_COLOR = '1'
  bg.exitOasisBg(write)
  assert.ok(out.length > 0, 'a ground already changed is restored under NO_COLOR; exitOasisBg in src/screen/cockpit/oasisBg.ts must restore a changed ground whatever NO_COLOR says')
  const restored = out.join('')
  bg.exitOasisBg(write)
  assert.equal(out.join(''), restored, 'restoration stays exactly once; exitOasisBg in src/screen/cockpit/oasisBg.ts must not write a second restore')
  bg._resetGroundForTest()
  process.env.FORCE_COLOR = '3'
  out.length = 0
  bg.syncOasisBgToTheme('dark', write)
  assert.ok(out.join('').includes('\x1b]11;'), 'the explicit colour override keeps its precedence; syncOasisBgToTheme in src/screen/cockpit/oasisBg.ts must let FORCE_COLOR win over NO_COLOR')
  console.log('NO COLOR GROUND GREEN')
} finally {
  if (tty) Object.defineProperty(process.stdout, 'isTTY', tty)
  else delete (process.stdout as unknown as { isTTY?: boolean }).isTTY
  rmSync(home, { recursive: true, force: true })
}
