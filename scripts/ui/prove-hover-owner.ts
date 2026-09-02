#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-hover-owner.ts — the single-owner hover store (the
//  chain-highlight hardening).
//
//  The bug: per-row `useState` hover + paired enter/leave events — a fast
//  sweep, a leave landing outside any hoverable cell, or a drag drops the
//  leave and strands rows highlighted (operator screenshot: rows lit across
//  DIFFERENT rail cards at once, and lit while the button was down). The
//  store makes the invariant structural; this proof pins its contract:
//    · at most one owner, claims displace;
//    · stale releases never clobber newer claims;
//    · press clears + suppresses, release re-arms;
//    · the no-button-motion signal re-arms after a lost release.
//  Plus the adoption ratchet: no component-level paired-useState hover
//  survives outside the sanctioned non-paint site (suggestion selection).
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  claimHover,
  getHoverOwner,
  releaseHover,
  resetHoverOwnerForTest,
  setHoverPointerDown,
  subscribeHover,
} from '../../src/utils/cockpit/hoverOwner.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' hover owner — single-owner store contract')
console.log('============================================================')

resetHoverOwnerForTest()
console.log('\n── at most ONE owner, claims displace ──────────────────────')
claimHover('a')
check('claim lights a', getHoverOwner() === 'a')
claimHover('b')
check("a fast sweep's next claim displaces the previous owner", getHoverOwner() === 'b')
releaseHover('a')
check('a STALE release (missed-leave row) never clobbers the newer claim', getHoverOwner() === 'b')
releaseHover('b')
check('the real owner releases clean', getHoverOwner() === null)

console.log('\n── press clears + suppresses; release re-arms ──────────────')
claimHover('row')
setHoverPointerDown(true)
check('press clears the lingering highlight', getHoverOwner() === null)
claimHover('other')
check('claims are suppressed while the button is down (drag)', getHoverOwner() === null)
setHoverPointerDown(false)
claimHover('other')
check('release re-arms claims', getHoverOwner() === 'other')

console.log('\n── lost-release recovery (mode-1003 no-button motion) ──────')
resetHoverOwnerForTest()
setHoverPointerDown(true) // press whose release the terminal never delivered
setHoverPointerDown(false) // the no-button motion signal (App.tsx recovery)
claimHover('healed')
check('hover works again after a lost release', getHoverOwner() === 'healed')

console.log('\n── notify discipline ───────────────────────────────────────')
resetHoverOwnerForTest()
let fired = 0
const un = subscribeHover(() => {
  fired++
})
claimHover('x')
claimHover('x') // idempotent — no re-notify
releaseHover('y') // non-owner — no notify
check('idempotent claims / non-owner releases never notify', fired === 1, `fired=${fired}`)
setHoverPointerDown(false) // already up — no notify
check('no-op button transitions never notify', fired === 1, `fired=${fired}`)
un()

console.log('\n── adoption ratchet: no paired-useState hover paint remains ─')
{
  const ROOT = join(import.meta.dir, '..', '..')
  // In-process walk, never a shelled grep (the vacuous rg-ENOENT class: a
  // missing binary + `|| true` made this leg pass on empty output). Any
  // `setHover*(…)`-style paired local hover in components is the
  // stranded-highlight pattern reintroduced. The suggestion-selection site
  // (PromptInputFooterSuggestions) is selection-move, not hover paint — its
  // handler is onHover, which this pattern does not match.
  const { readdirSync } = await import('node:fs')
  const hits: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.tsx') && /setHover(ed|edKey)?\(/.test(readFileSync(p, 'utf8')))
        hits.push(p)
    }
  }
  walk(join(ROOT, 'src/components'))
  walk(join(ROOT, 'src/screens'))
  check(
    'zero paired-useState hover sites across src/components + src/screens',
    hits.length === 0,
    hits.join(', '),
  )
  const app = readFileSync(join(ROOT, 'src/ink/components/App.tsx'), 'utf8')
  check('the mouse decode reports press to the store', app.includes('setHoverPointerDown(true)'))
  check(
    'the mouse decode reports release + lost-release recovery',
    app.split('setHoverPointerDown(false)').length >= 3,
  )
}

console.log()
if (failures > 0) {
  console.log(`❌ HOVER-OWNER PROOF RED (${failures})`)
  process.exit(1)
}
console.log('✅ HOVER-OWNER PROOF PASS')
