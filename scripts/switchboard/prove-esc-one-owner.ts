#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-esc-one-owner.ts
//  PROOF: one keypress has exactly ONE owner — the topmost painted surface
//  (the esc-one-owner ruling, COORDKEYS item 3).
//
//  The live sighting: with the repo selector open on the concourse and a
//  permission prompt (the one-time capacity ask) pending BEHIND it, esc —
//  meant to close the selector — ALSO answered the buried ask: the modal
//  owner consulted an ARRIVAL ladder (capacity/trust first) while the
//  screen PAINTS the selector above those asks, so the buried prompt ate
//  the key. The law now: boardModalOwner's precedence IS the screen's
//  paint order, topmost first, and a buried prompt survives an overlay
//  close untouched.
//
//   §1 the sighting scene: capacity ask armed BEHIND the open repo
//      selector ⇒ the selector owns the keys (red at base: capacity-ask).
//   §2 the whole paint-order law, pairwise: for every armed pair, the
//      owner is the surface that paints on top.
//   §3 the screen's arms follow the owner: the daemon offer yields under
//      any modal; the help atlas owns keys only as the topmost layer;
//      the buried-ask grammar cannot fire while covered (source pins).
//   §4 the overlay-stack esc law stands beside it: esc closes exactly one
//      layer per event (the one-pop stamp), and a non-top list declines.
//
//  Run:  ~/.bun/bin/bun run scripts/switchboard/prove-esc-one-owner.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { boardModalOwner } = await import('../../src/components/concourse/boardModalOwner.ts')

type Facts = Parameters<typeof boardModalOwner>[0]
const none: Facts = {
  capacityAsk: false,
  trustAsk: false,
  settingsOpen: false,
  groundPickerOpen: false,
  rowPick: false,
  seatAsk: false,
  gitOffer: false,
  contractAsk: false,
  managerSeatAsk: false,
  managerCardArmed: false,
  coordinatorFocused: false,
}

section('§1 the sighting: a capacity ask pending BEHIND the open repo selector')
{
  const owner = boardModalOwner({ ...none, capacityAsk: true, groundPickerOpen: true })
  check(
    'the repo selector owns the keys — the buried ask survives esc untouched',
    owner === 'ground-picker',
    String(owner),
  )
  const trustBehind = boardModalOwner({ ...none, capacityAsk: true, trustAsk: true, groundPickerOpen: true })
  check(
    'the trust ask paints ABOVE the selector and owns when armed beside it',
    trustBehind === 'trust-ask',
    String(trustBehind),
  )
}

section('§2 the whole paint-order law, pairwise')
{
  // The screen's paint order, topmost first — absolute modals exactly as
  // ConcourseScreen's JSX stacks them, then the in-pane cards' tail order.
  const paintOrder: Array<[keyof Facts, string]> = [
    ['rowPick', 'row-pick'],
    ['trustAsk', 'trust-ask'],
    ['groundPickerOpen', 'ground-picker'],
    ['managerSeatAsk', 'manager-seat-ask'],
    ['seatAsk', 'seat-ask'],
    ['capacityAsk', 'capacity-ask'],
    ['settingsOpen', 'settings'],
    ['helpOpen', 'help'],
    ['gitOffer', 'git-offer'],
    ['contractAsk', 'contract-ask'],
  ]
  let pairwiseHolds = true
  const broke: string[] = []
  for (let hi = 0; hi < paintOrder.length; hi++) {
    for (let lo = hi + 1; lo < paintOrder.length; lo++) {
      const [hiKey, hiOwner] = paintOrder[hi]!
      const [loKey] = paintOrder[lo]!
      const owner = boardModalOwner({ ...none, [hiKey]: true, [loKey]: true } as Facts)
      if (owner !== hiOwner) {
        pairwiseHolds = false
        broke.push(`${String(hiKey)}+${String(loKey)}→${String(owner)}`)
      }
    }
  }
  check('for EVERY armed pair, the top-painted surface owns the keys', pairwiseHolds, broke.join(' · '))
  check('nothing armed ⇒ no owner (the regions own their grammars)', boardModalOwner(none) === null)
  const managerScoped = boardModalOwner({ ...none, managerCardArmed: true })
  const managerFocused = boardModalOwner({ ...none, managerCardArmed: true, coordinatorFocused: true })
  check(
    'the manager card stays the one focus-scoped owner',
    managerScoped === null && managerFocused === 'manager-card',
    `${String(managerScoped)}/${String(managerFocused)}`,
  )
}

section("§3 the screen's arms follow the owner")
{
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  check(
    'the daemon offer yields under ANY modal (owner-null guard on its arm)',
    screen.includes("modalOwner === null && callbacks.daemonOfferArmed?.() === true"),
  )
  check(
    "the help atlas consumes only as the owner (modalOwner === 'help')",
    screen.includes("if (modalOwner === 'help')"),
  )
  check(
    'no bare helpOpen arm consumes ahead of the owner computation',
    !screen.includes('if (helpOpenRef.current) {\n      event.stopImmediatePropagation()'),
  )
  check(
    'the owner facts carry helpOpen (the atlas is in the paint order)',
    screen.includes('helpOpen: helpOpenRef.current,'),
  )
  const ownerSrc = read('src/components/concourse/boardModalOwner.ts')
  check(
    'the owner module records the ruling (paint order, topmost first)',
    ownerSrc.includes('THE TOPMOST PAINTED SURFACE') && ownerSrc.includes('esc-one-owner'),
  )
}

section('§4 the overlay-stack esc law beside it (one esc, one layer)')
{
  const { pushOverlay, popOverlay, isTopOverlayNow, resetOverlayStackForTests, overlayStackSnapshot } = await import(
    '../../src/context/overlayStack.ts'
  )
  const input = await import('../../src/ink/events/input-event.ts')
  resetOverlayStackForTests()
  const below = pushOverlay({ id: 'select', modal: true })
  const top = pushOverlay({ id: 'concourse-ground', modal: true })
  check('the later push is top (paint follows mount for stacked selects)', isTopOverlayNow(top) && !isTopOverlayNow(below))
  // One esc pops one layer: after the top pops IN THIS EVENT, the newly-top
  // layer still declines (the one-pop stamp) — the buried prompt survives.
  popOverlay(top)
  const belowActsInSameEvent = isTopOverlayNow(below)
  check(
    'after the top layer pops mid-event, the buried layer still declines (one pop per input event)',
    belowActsInSameEvent === false,
    JSON.stringify({ snapshot: overlayStackSnapshot().map(e => e.id), seq: (input as { currentInputEventSeq?: () => number }).currentInputEventSeq?.() }),
  )
  resetOverlayStackForTests()
}

console.log('')
if (failures > 0) {
  console.log(`prove-esc-one-owner: ${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('prove-esc-one-owner: all checks passed')
