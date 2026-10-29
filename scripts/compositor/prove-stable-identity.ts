#!/usr/bin/env bun
import {
  consumeHelmActivation,
  getHelmCursor,
  currentHelmRow,
  publishHelmRows,
  moveHelmCursor,
  requestHelmRowActivation,
  requestHelmRowActivationBySig,
  resetHelmFocusForTest,
  setHelmCursor,
  setHelmCursorBySig,
  helmRowSig,
  type HelmRow,
} from '../../src/utils/cockpit/helmFocus.js'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

const row = (label: string): HelmRow => ({ kind: 'command', command: `/${label}`, label })
const A = row('run:alpha')
const B = row('run:beta')
const C = row('run:gamma')
const X = row('run:xray')

console.log('stable interaction identity (helmFocus)')

{
  resetHelmFocusForTest()
  publishHelmRows('lanes', [A, B, C])
  publishHelmRows('lanes', [X, A, B, C])
  check('untouched rail stays at the top across inserts', getHelmCursor('lanes') === 0 && currentHelmRow('lanes') === X)
}

{
  resetHelmFocusForTest()
  publishHelmRows('lanes', [A, B, C])
  setHelmCursor('lanes', 1)
  publishHelmRows('lanes', [X, A, B, C])
  check('insert-above re-anchors the cursor to its row', currentHelmRow('lanes') === B, `at ${getHelmCursor('lanes')}`)
  check('…at the shifted index', getHelmCursor('lanes') === 2)
}

{
  resetHelmFocusForTest()
  publishHelmRows('lanes', [X, A, B, C])
  setHelmCursor('lanes', 2)
  publishHelmRows('lanes', [A, B, C])
  check('remove-above re-anchors the cursor to its row', currentHelmRow('lanes') === B)
}

{
  resetHelmFocusForTest()
  publishHelmRows('lanes', [A, B, C])
  setHelmCursor('lanes', 1)
  publishHelmRows('lanes', [A, C])
  check('vanished row falls back to the clamped position', currentHelmRow('lanes') === C)
  publishHelmRows('lanes', [X, A, C])
  check('…and the fallback row is the NEW anchor', currentHelmRow('lanes') === C)
}

{
  resetHelmFocusForTest()
  publishHelmRows('lanes', [A, B, C])
  requestHelmRowActivation('lanes', 1)
  publishHelmRows('lanes', [X, A, B, C])
  const action = consumeHelmActivation()
  check(
    'pending click survives a reorder and still activates the CLICKED row',
    action?.type === 'command' && action.command === '/run:beta',
    JSON.stringify(action),
  )
}

{
  resetHelmFocusForTest()
  publishHelmRows('lanes', [A, B, C])
  requestHelmRowActivation('lanes', 1)
  publishHelmRows('lanes', [A, C])
  check('a vanished clicked row activates NOTHING', consumeHelmActivation() === null)
}

{
  resetHelmFocusForTest()
  publishHelmRows('lanes', [A, B, C])
  setHelmCursorBySig('lanes', helmRowSig(C))
  check('setHelmCursorBySig lands on the row', currentHelmRow('lanes') === C)
  setHelmCursorBySig('lanes', 't:ghost:nope')
  check('…unknown sig is a no-op', currentHelmRow('lanes') === C)
  requestHelmRowActivationBySig('lanes', helmRowSig(A))
  const act = consumeHelmActivation()
  check('requestHelmRowActivationBySig activates by identity', act?.type === 'command' && act.command === '/run:alpha')
  requestHelmRowActivationBySig('lanes', 't:ghost:nope')
  check('…unknown sig arms nothing', consumeHelmActivation() === null)
}

{
  resetHelmFocusForTest()
  publishHelmRows('lanes', [A, B])
  moveHelmCursor('lanes', +5)
  check('move clamps at the end', getHelmCursor('lanes') === 1)
  moveHelmCursor('lanes', -5)
  check('move clamps at the start', getHelmCursor('lanes') === 0)
}

if (failures > 0) {
  console.error(`\n❌ ${failures} STABLE-IDENTITY PROOF(S) FAILED`)
  process.exit(1)
}
console.log('\n✅ ALL STABLE-IDENTITY PROOFS PASS')
