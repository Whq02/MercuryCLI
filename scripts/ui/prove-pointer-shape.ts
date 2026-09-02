#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ps = await import('../../src/utils/cockpit/pointerShape.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' pointer shape — OSC 22 honesty (bytes · dedup · teardown)')
console.log('============================================================')

const prev = process.env.MERCURY_POINTER_SHAPE
delete process.env.MERCURY_POINTER_SHAPE

try {
  check('text shape bytes', ps.pointerShapeSeq('text') === '\x1b]22;text\x07')
  check('default (arrow) shape bytes', ps.pointerShapeSeq('default') === '\x1b]22;default\x07')
  check('reset = empty-param OSC 22', ps.POINTER_SHAPE_RESET === '\x1b]22;\x07')

  ps.resetPointerShapeForTest()
  const writes: string[] = []
  const w = (s: string): void => {
    writes.push(s)
  }
  ps.applyPointerShape(false, w)
  ps.applyPointerShape(false, w)
  ps.applyPointerShape(false, w)
  check('a chatty same-shape stream emits ONE write', writes.length === 1 && writes[0] === '\x1b]22;default\x07')
  ps.applyPointerShape(true, w)
  ps.applyPointerShape(true, w)
  check('a flip emits exactly one more', writes.length === 2 && writes[1] === '\x1b]22;text\x07')

  ps.resetPointerShape(w)
  check('reset emits the restore bytes', writes.length === 3 && writes[2] === '\x1b]22;\x07')
  ps.resetPointerShape(w)
  check('a second reset is a no-op (nothing latched)', writes.length === 3)
  ps.applyPointerShape(true, w)
  check('after reset the first shape re-emits unconditionally', writes.length === 4)

  ps.resetPointerShapeForTest()
  process.env.MERCURY_POINTER_SHAPE = '0'
  const killed: string[] = []
  ps.applyPointerShape(true, s => killed.push(s))
  ps.applyPointerShape(false, s => killed.push(s))
  check('=0 emits nothing ever', killed.length === 0)
  delete process.env.MERCURY_POINTER_SHAPE

  const ink = readFileSync(join(import.meta.dir, '../../src/ink/ink.tsx'), 'utf8')
  check('hover chokepoint applies the shape from the noSelect bitmap',
    ink.includes('screen.noSelect[row * screen.width + col] !== 1') &&
    ink.includes('applyPointerShape(selectable'))
  check('empty cells read as NOT selectable', ink.includes('!isEmptyCellAt(screen, col, row)'))
  check('/mouse off resets the shape', /if \(!on\) resetPointerShape/.test(ink))
  check('alt-screen exit resets the shape', /Leaving the alt screen hands the pointer back[\s\S]{0,200}resetPointerShape/.test(ink))
  const teardown = readFileSync(join(import.meta.dir, '../../src/ink/root/teardown.ts'), 'utf8')
  check('signal-exit unmount resets the shape (synchronous fd-1 teardown step)',
    ink.includes('resetPointer: resetPointerShape') &&
    ink.includes('writeAllSync(1, Buffer.from(bytes') &&
    teardown.includes("case 'pointer-reset':"))
} finally {
  if (prev === undefined) delete process.env.MERCURY_POINTER_SHAPE
  else process.env.MERCURY_POINTER_SHAPE = prev
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ ${failures} CHECK(S) FAILED`)
  process.exit(1)
}
console.log('✅ POINTER SHAPE PROOF PASS')
