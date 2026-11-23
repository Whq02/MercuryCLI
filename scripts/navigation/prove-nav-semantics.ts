#!/usr/bin/env bun
import {
  applyNavMotion,
  decodeDomNavKey,
  decodeNavKey,
  skipDisabled,
  type NavAction,
  type NavDecodeOptions,
} from '../../src/screen/widgets/navSemantics.js'
import type { Key } from '../../src/screen/renderer/events/input-event.js'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  if (!cond || process.env.COMPASS_PROOF_VERBOSE) {
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail ? `${detail} — ` : ''}fix decodeNavKey and decodeDomNavKey (key to action), applyNavMotion (motion) or skipDisabled (disabled rows) in src/screen/widgets/navSemantics.ts` : detail ? ` — ${detail}` : ''}`)
  }
}

const K = (over: Partial<Key> = {}): Key => ({
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  wheelUp: false,
  wheelDown: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  fn: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  ...over,
})

const dec = (input: string, over: Partial<Key>, opts: NavDecodeOptions): NavAction | null =>
  decodeNavKey(input, K(over), opts)

console.log('== the vertical law: ←→ are never disguised ↑↓ ==')
const V: NavDecodeOptions = { orientation: 'vertical' }
check('↑ → movePrevious', dec('', { upArrow: true }, V) === 'movePrevious')
check('↓ → moveNext', dec('', { downArrow: true }, V) === 'moveNext')
check('← decodes NOTHING on a plain vertical list', dec('', { leftArrow: true }, V) === null)
check('→ decodes NOTHING on a plain vertical list', dec('', { rightArrow: true }, V) === null)
check('ctrl+p rides with ↑', dec('p', { ctrl: true }, V) === 'movePrevious')
check('ctrl+n rides with ↓', dec('n', { ctrl: true }, V) === 'moveNext')
check('home → first', dec('', { home: true }, V) === 'first')
check('end → last', dec('', { end: true }, V) === 'last')
check('esc → cancel', dec('', { escape: true }, V) === 'cancel')
check('↵ → activate', dec('', { return: true }, V) === 'activate')
check('pageUp decodes NOTHING without a declared viewport', dec('', { pageUp: true }, V) === null)
check('pageUp → pagePrevious with pageKeys', dec('', { pageUp: true }, { ...V, pageKeys: true }) === 'pagePrevious')
check('pageDown → pageNext with pageKeys', dec('', { pageDown: true }, { ...V, pageKeys: true }) === 'pageNext')
check('space is a plain printable without spaceToggles', dec(' ', {}, V) === null)
check('space → toggle where declared', dec(' ', {}, { ...V, spaceToggles: true }) === 'toggle')
check('tab decodes NOTHING without tabFocus', dec('', { tab: true }, V) === null)
check('tab → focusNext with tabFocus', dec('', { tab: true }, { ...V, tabFocus: true }) === 'focusNext')
check('shift+tab → focusPrevious', dec('', { tab: true, shift: true }, { ...V, tabFocus: true }) === 'focusPrevious')

console.log('== hierarchy + the advertised ←-close convention ==')
const H: NavDecodeOptions = { orientation: 'vertical', hierarchy: true }
check('← → leaveChild on a taught hierarchy', dec('', { leftArrow: true }, H) === 'leaveChild')
check('→ → enterChild on a taught hierarchy', dec('', { rightArrow: true }, H) === 'enterChild')
const LC: NavDecodeOptions = { orientation: 'vertical', leftCloses: true }
check('← → cancel under the advertised close convention', dec('', { leftArrow: true }, LC) === 'cancel')
check('hierarchy outranks leftCloses', dec('', { leftArrow: true }, { ...H, leftCloses: true }) === 'leaveChild')

console.log('== the horizontal law: ↑↓ are never a silent second spelling ==')
const Hz: NavDecodeOptions = { orientation: 'horizontal' }
check('← → moveLeft', dec('', { leftArrow: true }, Hz) === 'moveLeft')
check('→ → moveRight', dec('', { rightArrow: true }, Hz) === 'moveRight')
check('↑ decodes NOTHING on a horizontal control', dec('', { upArrow: true }, Hz) === null)
check('↓ decodes NOTHING on a horizontal control', dec('', { downArrow: true }, Hz) === null)

console.log('== the grid law: keys obey the visible geometry ==')
const G: NavDecodeOptions = { orientation: { grid: { columns: 2 } } }
check('grid ← → moveLeft', dec('', { leftArrow: true }, G) === 'moveLeft')
check('grid → → moveRight', dec('', { rightArrow: true }, G) === 'moveRight')
check('grid ↑ → movePrevious (by row)', dec('', { upArrow: true }, G) === 'movePrevious')
check('grid ↓ → moveNext (by row)', dec('', { downArrow: true }, G) === 'moveNext')

console.log('== motion application: clamp-don\'t-wrap; grid row stride ==')
check('vertical ↓ from 0/3 → 1', applyNavMotion('moveNext', 0, 3, { orientation: 'vertical' }) === 1)
check('vertical ↑ clamps at 0', applyNavMotion('movePrevious', 0, 3, { orientation: 'vertical' }) === 0)
check('vertical ↓ clamps at end', applyNavMotion('moveNext', 2, 3, { orientation: 'vertical' }) === 2)
check('first → 0', applyNavMotion('first', 2, 3, { orientation: 'vertical' }) === 0)
check('last → n-1', applyNavMotion('last', 0, 3, { orientation: 'vertical' }) === 2)
check('page moves by pageSize', applyNavMotion('pageNext', 0, 20, { orientation: 'vertical', pageSize: 7 }) === 7)
check('grid ↓ moves by row (+columns)', applyNavMotion('moveNext', 0, 4, { orientation: { grid: { columns: 2 } } }) === 2)
check('grid ↑ moves by row (−columns)', applyNavMotion('movePrevious', 3, 4, { orientation: { grid: { columns: 2 } } }) === 1)
check('grid → moves linearly', applyNavMotion('moveRight', 0, 4, { orientation: { grid: { columns: 2 } } }) === 1)
check('grid ↓ clamps on the partial last row', applyNavMotion('moveNext', 2, 4, { orientation: { grid: { columns: 2 } } }) === 3)
check('empty list → null', applyNavMotion('moveNext', 0, 0, { orientation: 'vertical' }) === null)
check('activate is not a motion', applyNavMotion('activate', 1, 3, { orientation: 'vertical' }) === null)

console.log('== disabled rows are skipped (never landed, never wrapped) ==')
const dis = (set: number[]) => (i: number) => set.includes(i)
check('skips one disabled row forward', skipDisabled(0, 1, 4, dis([1])) === 2)
check('skips a disabled run forward', skipDisabled(0, 1, 5, dis([1, 2, 3])) === 4)
check('skips backward', skipDisabled(3, 2, 4, dis([2])) === 1)
check('all-disabled ahead falls back toward the origin', skipDisabled(1, 2, 4, dis([2, 3])) === 1)
check('enabled target lands unchanged', skipDisabled(0, 2, 4, dis([1])) === 2)
check('never wraps past the front', skipDisabled(2, 1, 4, dis([0, 1])) === 2)

console.log('== DOM-boundary decode (the onKeyDown family) ==')
check("dom 'up' → movePrevious", decodeDomNavKey({ key: 'up' }, V) === 'movePrevious')
check("dom ctrl+'n' → moveNext", decodeDomNavKey({ key: 'n', ctrl: true }, V) === 'moveNext')
check("dom 'return' → activate", decodeDomNavKey({ key: 'return' }, V) === 'activate')
check("dom 'escape' → cancel", decodeDomNavKey({ key: 'escape' }, V) === 'cancel')
check("dom 'left' decodes NOTHING on vertical", decodeDomNavKey({ key: 'left' }, V) === null)


console.log('')
if (failures > 0) {
  console.log(`❌ nav-semantics: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ nav-semantics — one vocabulary, orientation-honest keys, disabled rows skipped, kernel adopted')
