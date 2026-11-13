#!/usr/bin/env bun
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const { boardModalOwner, boardModalArmed } = await import('../../src/components/concourse/boardModalOwner.ts')
type Facts = import('../../src/components/concourse/boardModalOwner.ts').BoardModalFactsV1

const none: Facts = {
  capacityAsk: false,
  trustAsk: false,
  settingsOpen: false,
  groundPickerOpen: false,
  rowPick: false,
  gitOffer: false,
  contractAsk: false,
}
const facts = (over: Partial<Facts>): Facts => ({ ...none, ...over })

console.log('§1 — one owner at a time, in the paint order (topmost first)')
{
  const order: Array<[keyof Facts, string]> = [
    ['modelDefault', 'model-default'],
    ['rowPick', 'row-pick'],
    ['trustAsk', 'trust-ask'],
    ['groundPickerOpen', 'ground-picker'],
    ['capacityAsk', 'capacity-ask'],
    ['settingsOpen', 'settings'],
    ['helpOpen', 'help'],
    ['gitOffer', 'git-offer'],
    ['contractAsk', 'contract-ask'],
  ]
  for (const [fact, owner] of order) {
    check(`${String(fact)} alone owns as '${owner}'`, boardModalOwner(facts({ [fact]: true } as Partial<Facts>)) === owner)
  }
  let pairsHeld = 0
  for (let a = 0; a < order.length; a++) {
    for (let b = a + 1; b < order.length; b++) {
      const both = facts({ [order[a]![0]]: true, [order[b]![0]]: true } as Partial<Facts>)
      if (boardModalOwner(both) === order[a]![1]) pairsHeld++
    }
  }
  const pairs = (order.length * (order.length - 1)) / 2
  check(`every armed PAIR resolves to the earlier owner (${pairs} of ${pairs} — one stream, one owner)`, pairsHeld === pairs, String(pairsHeld))
  check(
    'the whole lattice armed at once still answers the first owner',
    boardModalOwner(
      facts({
        capacityAsk: true,
        trustAsk: true,
        settingsOpen: true,
        groundPickerOpen: true,
        rowPick: true,
        helpOpen: true,
        gitOffer: true,
        contractAsk: true,
      }),
    ) === 'row-pick',
  )
}

console.log('§2 — nothing armed ⇒ null; boardModalArmed mirrors the owner')
{
  check('the empty board answers null', boardModalOwner(none) === null)
  check('boardModalArmed is exactly owner !== null (both directions)', boardModalArmed(none) === false && boardModalArmed(facts({ rowPick: true })) === true && boardModalArmed(facts({ contractAsk: true })) === true)
}

console.log(failures === 0 ? '\nprove-board-modal-owner: ALL GREEN' : `\nprove-board-modal-owner: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
