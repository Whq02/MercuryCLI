#!/usr/bin/env bun
import { join } from 'node:path'


let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const failHint = cond ? '' : ' | to fix: the paint-order owner is boardModalOwner in src/components/concourse/boardModalOwner.ts (section 1 and 2); the one-pop-per-event esc law is isTopOverlayNow and popOverlay in src/context/overlayStack.ts (section 4)'
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}${failHint}`)
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
  gitOffer: false,
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
  const paintOrder: Array<[keyof Facts, string]> = [
    ['modelDefault', 'model-default'],
    ['rowPick', 'row-pick'],
    ['trustAsk', 'trust-ask'],
    ['groundPickerOpen', 'ground-picker'],
    ['capacityAsk', 'capacity-ask'],
    ['settingsOpen', 'settings'],
    ['helpOpen', 'help'],
    ['gitOffer', 'git-offer'],
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
