#!/usr/bin/env bun
// ============================================================================
//  prove-board-modal-owner.ts — the ONE key-ownership predicate for the
//  concourse's consent surfaces (the one-Select modal class; built under the
//  lead's option-1 ruling: the predicate lands first, the ConcourseScreen
//  wiring lands as its own commit AFTER the letter-verb-yield fold).
//
//  §1 one owner at a time, in the PAINT order (the esc-one-owner ruling,
//     COORDKEYS item 3: the topmost painted surface owns the key stream —
//     the earlier ARRIVAL ladder let a capacity ask pending behind the open
//     repo selector eat the selector's esc) — never two.
//  §2 the manager card is the one FOCUS-SCOPED owner: it holds keys only
//     while the coordinator panel has focus; everything above it is
//     screen-wide while armed.
//  §3 nothing armed ⇒ null (the regions' own grammars apply), and
//     boardModalArmed mirrors the owner exactly.
// ============================================================================
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
  seatAsk: false,
  gitOffer: false,
  contractAsk: false,
  managerSeatAsk: false,
  managerCardArmed: false,
  coordinatorFocused: false,
}
const facts = (over: Partial<Facts>): Facts => ({ ...none, ...over })

console.log('§1 — one owner at a time, in the paint order (topmost first)')
{
  const order: Array<[keyof Facts, string]> = [
    ['rowPick', 'row-pick'],
    ['trustAsk', 'trust-ask'],
    ['groundPickerOpen', 'ground-picker'],
    ['managerSeatAsk', 'manager-seat-ask'],
    ['seatAsk', 'seat-ask'],
    ['capacityAsk', 'capacity-ask'],
    ['settingsOpen', 'settings'],
    ['gitOffer', 'git-offer'],
    ['contractAsk', 'contract-ask'],
  ]
  for (const [fact, owner] of order) {
    check(`${String(fact)} alone owns as '${owner}'`, boardModalOwner(facts({ [fact]: true } as Partial<Facts>)) === owner)
  }
  // Every pair resolves to the TOP-PAINTED of the two — the precedence is
  // total, so no two surfaces ever both read the stream (the pairwise-
  // lattice poison), and a buried prompt can never eat a key meant for the
  // overlay standing above it (the esc-one-owner sighting).
  let pairsHeld = 0
  for (let a = 0; a < order.length; a++) {
    for (let b = a + 1; b < order.length; b++) {
      const both = facts({ [order[a]![0]]: true, [order[b]![0]]: true } as Partial<Facts>)
      if (boardModalOwner(both) === order[a]![1]) pairsHeld++
    }
  }
  check('every armed PAIR resolves to the earlier owner (36 of 36 — one stream, one owner)', pairsHeld === 36, String(pairsHeld))
  check(
    'the whole lattice armed at once still answers the first owner',
    boardModalOwner(
      facts({
        capacityAsk: true,
        trustAsk: true,
        settingsOpen: true,
        groundPickerOpen: true,
        rowPick: true,
        seatAsk: true,
        gitOffer: true,
        contractAsk: true,
        managerSeatAsk: true,
        managerCardArmed: true,
        coordinatorFocused: true,
      }),
    ) === 'row-pick',
  )
}

console.log('§2 — the manager card is the one focus-scoped owner')
{
  check('armed + coordinator focused ⇒ manager-card owns', boardModalOwner(facts({ managerCardArmed: true, coordinatorFocused: true })) === 'manager-card')
  check('armed + focus elsewhere ⇒ NO owner (tab away and the board stays reachable — the interview never imprisons the screen)', boardModalOwner(facts({ managerCardArmed: true, coordinatorFocused: false })) === null)
  check('every screen-wide owner outranks it at the mount', boardModalOwner(facts({ managerCardArmed: true, coordinatorFocused: true, gitOffer: true })) === 'git-offer' && boardModalOwner(facts({ managerCardArmed: true, coordinatorFocused: true, managerSeatAsk: true })) === 'manager-seat-ask')
  check('coordinator focus ALONE arms nothing', boardModalOwner(facts({ coordinatorFocused: true })) === null)
}

console.log('§3 — nothing armed ⇒ null; boardModalArmed mirrors the owner')
{
  check('the empty board answers null', boardModalOwner(none) === null)
  check('boardModalArmed is exactly owner !== null (both directions)', boardModalArmed(none) === false && boardModalArmed(facts({ rowPick: true })) === true && boardModalArmed(facts({ managerCardArmed: true, coordinatorFocused: false })) === false)
}

console.log(failures === 0 ? '\nprove-board-modal-owner: ALL GREEN' : `\nprove-board-modal-owner: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
