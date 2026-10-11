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
  const bg = await import('../../src/utils/cockpit/oasisBg.ts')
  const out: string[] = []
  const write = (text: string) => { out.push(text) }
  bg._resetGroundForTest()
  bg.syncOasisBgToTheme('dark', write)
  assert.equal(out.join(''), '', 'NO_COLOR plus a dark theme writes no OSC 11')
  bg.markOriginalGroundQuerySent()
  bg.noteOriginalGroundReply('#123456', write)
  assert.equal(out.join(''), '', 'the warm acquisition cannot bypass NO_COLOR')
  delete process.env.NO_COLOR
  process.env.TERM = 'dumb'
  bg.syncOasisBgToTheme('dark', write)
  assert.equal(out.join(''), '', 'TERM=dumb writes no OSC 11')
  process.env.TERM = 'xterm-256color'
  bg.syncOasisBgToTheme('mono', write)
  assert.equal(out.join(''), '', 'Black and white writes no OSC 11')
  bg.syncOasisBgToTheme('dark', write)
  assert.ok(out.join('').includes('\x1b]11;'), 'the control case paints the dark ground')
  out.length = 0
  process.env.NO_COLOR = '1'
  bg.exitOasisBg(write)
  assert.ok(out.length > 0, 'a ground already changed is restored under NO_COLOR')
  const restored = out.join('')
  bg.exitOasisBg(write)
  assert.equal(out.join(''), restored, 'restoration stays exactly once')
  bg._resetGroundForTest()
  process.env.FORCE_COLOR = '3'
  out.length = 0
  bg.syncOasisBgToTheme('dark', write)
  assert.ok(out.join('').includes('\x1b]11;'), 'the explicit colour override keeps its precedence')
  console.log('NO COLOR GROUND GREEN')
} finally {
  if (tty) Object.defineProperty(process.stdout, 'isTTY', tty)
  else delete (process.stdout as unknown as { isTTY?: boolean }).isTTY
  rmSync(home, { recursive: true, force: true })
}
