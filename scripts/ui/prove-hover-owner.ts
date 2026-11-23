#!/usr/bin/env bun
import {
  claimHover,
  getHoverOwner,
  releaseHover,
  resetHoverOwnerForTest,
  setHoverPointerDown,
  subscribeHover,
} from '../../src/screen/cockpit/hoverOwner.ts'

const H = 'src/screen/cockpit/hoverOwner.ts'
let failures = 0
function check(label: string, cond: boolean, detail = '', fix = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && fix ? ` — ${fix}` : ''}`)
}

console.log('============================================================')
console.log(' hover owner — single-owner store contract')
console.log('============================================================')

resetHoverOwnerForTest()
console.log('\n── at most ONE owner, claims displace ──────────────────────')
claimHover('a')
check('claim lights a', getHoverOwner() === 'a', '', `owner=${String(getHoverOwner())} — claimHover must set the owner (${H})`)
claimHover('b')
check("a fast sweep's next claim displaces the previous owner", getHoverOwner() === 'b', '', `owner=${String(getHoverOwner())} — a second claimHover must replace the first owner (${H})`)
releaseHover('a')
check('a STALE release (missed-leave row) never clobbers the newer claim', getHoverOwner() === 'b', '', `owner=${String(getHoverOwner())} — releaseHover must ignore an id that is not the current owner (${H})`)
releaseHover('b')
check('the real owner releases clean', getHoverOwner() === null, '', `owner=${String(getHoverOwner())} — releaseHover of the current owner must clear it (${H})`)

console.log('\n── press clears + suppresses; release re-arms ──────────────')
claimHover('row')
setHoverPointerDown(true)
check('press clears the lingering highlight', getHoverOwner() === null, '', `owner=${String(getHoverOwner())} — setHoverPointerDown(true) must clear the owner (${H})`)
claimHover('other')
check('claims are suppressed while the button is down (drag)', getHoverOwner() === null, '', `owner=${String(getHoverOwner())} — claimHover must do nothing while the pointer is down (${H})`)
setHoverPointerDown(false)
claimHover('other')
check('release re-arms claims', getHoverOwner() === 'other', '', `owner=${String(getHoverOwner())} — setHoverPointerDown(false) must let claimHover work again (${H})`)

console.log('\n── lost-release recovery (mode-1003 no-button motion) ──────')
resetHoverOwnerForTest()
setHoverPointerDown(true)
setHoverPointerDown(false)
claimHover('healed')
check('hover works again after a lost release', getHoverOwner() === 'healed', '', `owner=${String(getHoverOwner())} — claimHover must work after a down/up pair with no claim between (${H})`)

console.log('\n── notify discipline ───────────────────────────────────────')
resetHoverOwnerForTest()
let fired = 0
const un = subscribeHover(() => {
  fired++
})
claimHover('x')
claimHover('x')
releaseHover('y')
check('idempotent claims / non-owner releases never notify', fired === 1, `fired=${fired}`, `claimHover and releaseHover must notify subscribers only when the owner changes (${H})`)
setHoverPointerDown(false)
check('no-op button transitions never notify', fired === 1, `fired=${fired}`, `setHoverPointerDown must notify only when the down state changes (${H})`)
un()


console.log()
if (failures > 0) {
  console.log(`❌ HOVER-OWNER PROOF RED (${failures})`)
  process.exit(1)
}
console.log('✅ HOVER-OWNER PROOF PASS')
