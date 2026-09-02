#!/usr/bin/env bun
// ============================================================================
//  scripts/compositor/prove-stable-identity.ts — MERCURY Stable interaction identity: stable
//  interaction identity at the ONE index-based shared owner (helmFocus).
//
//  The Helm rails republish their row models from LIVE stores (runs,
//  workflows, party presence, TABULA bumps). Raw indices are the guarded class: a store cursor
//  and a pending click activation held as raw indices mean rows appearing or
//  vanishing ABOVE the cursor silently retarget the selection, and ↵/click
//  then activates whatever sits at that position (RUNS rows carry
//  per-task commands — the retarget opened the WRONG task). Now: the cursor
//  re-anchors by helmRowSig on every publish; a pending activation is
//  captured as the clicked row's signature and resolves by identity at
//  consume time; a vanished row is a NO-OP, never a different row.
// ============================================================================
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

// 0. NO user interaction yet: an untouched rail stays at the TOP as rows
//    insert — the anchor records user intent, never the first publish
//
{
  resetHelmFocusForTest()
  publishHelmRows('lanes', [A, B, C])
  publishHelmRows('lanes', [X, A, B, C])
  check('untouched rail stays at the top across inserts', getHelmCursor('lanes') === 0 && currentHelmRow('lanes') === X)
}

// 1. Insert ABOVE the cursor: the selection follows the ROW, not the index.
{
  resetHelmFocusForTest()
  publishHelmRows('lanes', [A, B, C])
  setHelmCursor('lanes', 1)
  publishHelmRows('lanes', [X, A, B, C])
  check('insert-above re-anchors the cursor to its row', currentHelmRow('lanes') === B, `at ${getHelmCursor('lanes')}`)
  check('…at the shifted index', getHelmCursor('lanes') === 2)
}

// 2. Remove ABOVE the cursor: same law, the other direction.
{
  resetHelmFocusForTest()
  publishHelmRows('lanes', [X, A, B, C])
  setHelmCursor('lanes', 2)
  publishHelmRows('lanes', [A, B, C])
  check('remove-above re-anchors the cursor to its row', currentHelmRow('lanes') === B)
}

// 3. The anchored row VANISHES: nearest-position fallback, then the fallback
//    row becomes the new anchor (no oscillation on the next publish).
{
  resetHelmFocusForTest()
  publishHelmRows('lanes', [A, B, C])
  setHelmCursor('lanes', 1)
  publishHelmRows('lanes', [A, C])
  check('vanished row falls back to the clamped position', currentHelmRow('lanes') === C)
  publishHelmRows('lanes', [X, A, C])
  check('…and the fallback row is the NEW anchor', currentHelmRow('lanes') === C)
}

// 4. A pending click resolves by IDENTITY across an interleaved publish.
{
  resetHelmFocusForTest()
  publishHelmRows('lanes', [A, B, C])
  requestHelmRowActivation('lanes', 1) // the operator clicked B
  publishHelmRows('lanes', [X, A, B, C]) // a live-store publish lands first
  const action = consumeHelmActivation()
  check(
    'pending click survives a reorder and still activates the CLICKED row',
    action?.type === 'command' && action.command === '/run:beta',
    JSON.stringify(action),
  )
}

// 5. The clicked row VANISHES before consume: no-op — never a different row.
{
  resetHelmFocusForTest()
  publishHelmRows('lanes', [A, B, C])
  requestHelmRowActivation('lanes', 1)
  publishHelmRows('lanes', [A, C])
  check('a vanished clicked row activates NOTHING', consumeHelmActivation() === null)
}

// 6. The sig verbs (the pointer path's identity-true entry points).
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

// 7. Keyboard movement still clamps exactly as pinned (the legacy laws hold).
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
