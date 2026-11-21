#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }


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
  check('text shape bytes', ps.pointerShapeSeq('text') === '\x1b]22;text\x07', `pointerShapeSeq in src/utils/cockpit/pointerShape.ts must return ESC ] 22 ; text BEL`)
  check('default (arrow) shape bytes', ps.pointerShapeSeq('default') === '\x1b]22;default\x07', `pointerShapeSeq in src/utils/cockpit/pointerShape.ts must return ESC ] 22 ; default BEL`)
  check('reset = empty-param OSC 22', ps.POINTER_SHAPE_RESET === '\x1b]22;\x07', `POINTER_SHAPE_RESET in src/utils/cockpit/pointerShape.ts must be ESC ] 22 ; BEL`)

  ps.resetPointerShapeForTest()
  const writes: string[] = []
  const w = (s: string): void => {
    writes.push(s)
  }
  ps.applyPointerShape(false, w)
  ps.applyPointerShape(false, w)
  ps.applyPointerShape(false, w)
  check('a chatty same-shape stream emits ONE write', writes.length === 1 && writes[0] === '\x1b]22;default\x07', `${writes.length} writes; applyPointerShape in src/utils/cockpit/pointerShape.ts must skip a shape equal to lastShape`)
  ps.applyPointerShape(true, w)
  ps.applyPointerShape(true, w)
  check('a flip emits exactly one more', writes.length === 2 && writes[1] === '\x1b]22;text\x07', `${writes.length} writes; applyPointerShape in src/utils/cockpit/pointerShape.ts must write once when the shape flips`)

  ps.resetPointerShape(w)
  check('reset emits the restore bytes', writes.length === 3 && writes[2] === '\x1b]22;\x07', `${writes.length} writes; resetPointerShape in src/utils/cockpit/pointerShape.ts must write POINTER_SHAPE_RESET after a latched shape`)
  ps.resetPointerShape(w)
  check('a second reset is a no-op (nothing latched)', writes.length === 3, `${writes.length} writes; resetPointerShape in src/utils/cockpit/pointerShape.ts must return early when lastShape is null`)
  ps.applyPointerShape(true, w)
  check('after reset the first shape re-emits unconditionally', writes.length === 4, `${writes.length} writes; resetPointerShape in src/utils/cockpit/pointerShape.ts must clear lastShape so the next applyPointerShape writes`)

  ps.resetPointerShapeForTest()
  process.env.MERCURY_POINTER_SHAPE = '0'
  const killed: string[] = []
  ps.applyPointerShape(true, s => killed.push(s))
  ps.applyPointerShape(false, s => killed.push(s))
  check('=0 emits nothing ever', killed.length === 0, `${killed.length} writes; applyPointerShape in src/utils/cockpit/pointerShape.ts must not write when MERCURY_POINTER_SHAPE is 0 (pointerShapeEnabled)`)
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
