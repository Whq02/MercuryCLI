#!/usr/bin/env bun
import {
  isTopOverlayNow,
  popOverlay,
  pushOverlay,
  overlayStackSnapshot,
  reserveOverlayToken,
  resetOverlayStackForTests,
  topOverlay,
} from '../../src/screen/overlays/overlayStack.js'
import { bumpInputEventSeqForMouse } from '../../src/screen/renderer/events/input-event.js'

let failures = 0
const failureWhere = 'change pushOverlay, popOverlay, isTopOverlayNow or topOverlayOwnsPageKeys in src/screen/overlays/overlayStack.ts, or the input event sequence in src/screen/renderer/events/input-event.ts (bumpInputEventSeqForMouse)'
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  if (!cond || process.env.COMPASS_PROOF_VERBOSE) {
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${cond ? '' : ' — ' + failureWhere}`)
  }
}

console.log('== the overlay stack: order · one-pop-per-event · focus return ==')
{
  resetOverlayStackForTests()
  const a = reserveOverlayToken()
  const b = reserveOverlayToken()
  let restoredA = 0
  let restoredB = 0
  pushOverlay({ token: a, id: 'board', modal: true, onFocusReturn: () => restoredA++ })
  pushOverlay({ token: b, id: 'confirm', modal: true, onFocusReturn: () => restoredB++ })
  check('push order = z-order (b on top)', isTopOverlayNow(b) && !isTopOverlayNow(a))
  check('the top entry is b', topOverlay()?.token === b)

  popOverlay(b)
  check('b restored focus on top-pop', restoredB === 1)
  check('a is structurally top after the pop', topOverlay()?.token === a)
  check('but a stands down within the SAME input event (one-pop cap)', !isTopOverlayNow(a))

  bumpInputEventSeqForMouse()
  check('the NEXT event re-arms the new top', isTopOverlayNow(a))

  const c = reserveOverlayToken()
  let restoredC = 0
  pushOverlay({ token: c, id: 'inner', modal: true, onFocusReturn: () => restoredC++ })
  popOverlay(a)
  check('a buried pop runs NO focus return', restoredA === 0)
  check('the top layer (c) survives a buried pop', topOverlay()?.token === c)
  popOverlay(c)
  check('c restored focus on top-pop', restoredC === 1)
  check('the stack drains clean', overlayStackSnapshot().length === 0)
  resetOverlayStackForTests()
}


console.log('== page-key ownership rides the overlay stack (pure) ==')
{
  const { topOverlayOwnsPageKeys } = await import('../../src/screen/overlays/overlayStack.js')
  resetOverlayStackForTests()
  check('no overlay ⇒ the transcript keeps page keys', !topOverlayOwnsPageKeys())
  const plain = reserveOverlayToken()
  pushOverlay({ token: plain, id: 'select', modal: true })
  check('a plain overlay does NOT claim page keys', !topOverlayOwnsPageKeys())
  const pager = reserveOverlayToken()
  pushOverlay({ token: pager, id: 'command-palette', modal: true, ownsPageKeys: true })
  check('a declared pager on top claims page keys', topOverlayOwnsPageKeys())
  popOverlay(pager)
  check('pop returns page keys to the transcript', !topOverlayOwnsPageKeys())
  popOverlay(plain)
  resetOverlayStackForTests()
}

console.log('')
if (failures > 0) {
  console.log(`❌ focus-routing: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ focus-routing — one layer per Escape, stack-based restoration, typed consumption, one editor machinery')
