#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }


const ps = await import('../../src/screen/cockpit/pointerShape.js')

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}

console.log('============================================================')
console.log(' pointer shape — OSC 22 honesty (bytes · dedup · teardown)')
console.log('============================================================')

const prev = process.env.MERCURY_POINTER_SHAPE
delete process.env.MERCURY_POINTER_SHAPE

try {
  check('text shape bytes', ps.pointerShapeSeq('text') === '\x1b]22;text\x07', '', 'Fix pointerShapeSeq in src/screen/cockpit/pointerShape.ts so the text shape returns OSC 22 with the word text.')
  check('default (arrow) shape bytes', ps.pointerShapeSeq('default') === '\x1b]22;default\x07', '', 'Fix pointerShapeSeq in src/screen/cockpit/pointerShape.ts so the default shape returns OSC 22 with the word default.')
  check('reset = empty-param OSC 22', ps.POINTER_SHAPE_RESET === '\x1b]22;\x07', '', 'Fix POINTER_SHAPE_RESET in src/screen/cockpit/pointerShape.ts to be OSC 22 with an empty parameter.')

  ps.resetPointerShapeForTest()
  const writes: string[] = []
  const w = (s: string): void => {
    writes.push(s)
  }
  ps.applyPointerShape(false, w)
  ps.applyPointerShape(false, w)
  ps.applyPointerShape(false, w)
  check('a chatty same-shape stream emits ONE write', writes.length === 1 && writes[0] === '\x1b]22;default\x07', '', 'Fix applyPointerShape in src/screen/cockpit/pointerShape.ts to skip a write when the shape equals lastShape.')
  ps.applyPointerShape(true, w)
  ps.applyPointerShape(true, w)
  check('a flip emits exactly one more', writes.length === 2 && writes[1] === '\x1b]22;text\x07', '', 'Fix applyPointerShape in src/screen/cockpit/pointerShape.ts to write once when the shape changes and not again for the same shape.')

  ps.resetPointerShape(w)
  check('reset emits the restore bytes', writes.length === 3 && writes[2] === '\x1b]22;\x07', '', 'Fix resetPointerShape in src/screen/cockpit/pointerShape.ts to write POINTER_SHAPE_RESET when a shape is latched.')
  ps.resetPointerShape(w)
  check('a second reset is a no-op (nothing latched)', writes.length === 3, '', 'Fix resetPointerShape in src/screen/cockpit/pointerShape.ts to return early when lastShape is null.')
  ps.applyPointerShape(true, w)
  check('after reset the first shape re-emits unconditionally', writes.length === 4, '', 'Fix resetPointerShape in src/screen/cockpit/pointerShape.ts to clear lastShape so applyPointerShape writes again.')

  ps.resetPointerShapeForTest()
  process.env.MERCURY_POINTER_SHAPE = '0'
  const killed: string[] = []
  ps.applyPointerShape(true, s => killed.push(s))
  ps.applyPointerShape(false, s => killed.push(s))
  check('=0 emits nothing ever', killed.length === 0, '', 'Fix applyPointerShape in src/screen/cockpit/pointerShape.ts to return before writing when the MERCURY_POINTER_SHAPE flag is off.')
  delete process.env.MERCURY_POINTER_SHAPE

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
