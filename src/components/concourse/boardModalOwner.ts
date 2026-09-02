// boardModalOwner — the ONE key-ownership predicate for the concourse's
// consent surfaces (the one-Select modal class). The board grew its modals one guard at a time — `seatAsk === null`
// on the git offer's two mounts, `!contractAsk` beside it, capacity/trust
// asks each early-returning on their own — an AD HOC pairwise lattice with
// no central owner, under which a list-region letter key could still fire
// beneath a standing Select (the keys-live-under-modals class).
//
// This module DECLARES the owner: given the armed facts, at most ONE modal
// owns the key stream — THE TOPMOST PAINTED SURFACE (the esc-one-owner
// ruling, COORDKEYS item 3: one keypress has exactly one owner, the topmost;
// a buried prompt survives an overlay close untouched). The precedence IS
// the screen's own paint order, absolute modals top-most first exactly as
// ConcourseScreen's JSX stacks them, then the in-pane cards in their landed
// tail order:
//
//   row-pick → trust-ask → ground-picker → manager-seat-ask → seat-ask →
//   capacity-ask → settings → help → git-offer → contract-ask → manager-card
//
// (The pre-ruling order consulted the ARRIVAL ladder instead — capacity-ask
// and trust-ask first — so a capacity ask pending BEHIND the repo selector
// consumed the esc meant to close the selector: the operator's live
// sighting. A re-ordering was a behavior change needing its own ruling; the
// esc-one-owner ruling is that ruling, and the paint order is now the law.)
//
// 'manager-card' is the one FOCUS-SCOPED owner: it holds the keys only
// while the coordinator panel has focus (tab away and the board stays
// reachable — the interview never imprisons the screen); every owner above
// it is screen-wide while armed.

export interface BoardModalFactsV1 {
  /** The one-time capacity ask is armed (y/n/esc, whole screen). */
  capacityAsk: boolean
  /** The trust ask is armed (y/n/esc, whole screen). */
  trustAsk: boolean
  /** The coordinator model picker (settings) is open. */
  settingsOpen: boolean
  /** The repo selector (ground picker) is open. */
  groundPickerOpen: boolean
  /** The row pick modal (model/effort) is open. */
  rowPick: boolean
  /** The seat-overload card stands (its own Select grammar). */
  seatAsk: boolean
  /** The git offer's standard card is mounted in the coordinator pane. */
  gitOffer: boolean
  /** The contract offer card stands (ledger T2 — its own Select settles;
   *  without the yield, esc beneath the card CANCELLED the birth its own
   *  row promises: the driven find). */
  contractAsk: boolean
  /** Manager mode's seat consent modal is armed. */
  managerSeatAsk: boolean
  /** A manager card (interview / plan) stands. */
  managerCardArmed: boolean
  /** The coordinator panel holds focus (the manager card's scope). */
  coordinatorFocused: boolean
  /** The key atlas (help) is open — the lowest absolute overlay. */
  helpOpen?: boolean
}

export type BoardModalOwnerV1 =
  | 'capacity-ask'
  | 'trust-ask'
  | 'settings'
  | 'ground-picker'
  | 'row-pick'
  | 'seat-ask'
  | 'git-offer'
  | 'contract-ask'
  | 'manager-seat-ask'
  | 'manager-card'
  | 'help'

/** The one owner of the key stream right now, or null when no modal is
 *  armed (the regions' own grammars apply). PURE — the prover drives it.
 *  Order = the screen's paint order, top-most painted surface first. */
export function boardModalOwner(facts: BoardModalFactsV1): BoardModalOwnerV1 | null {
  if (facts.rowPick) return 'row-pick'
  if (facts.trustAsk) return 'trust-ask'
  if (facts.groundPickerOpen) return 'ground-picker'
  if (facts.managerSeatAsk) return 'manager-seat-ask'
  if (facts.seatAsk) return 'seat-ask'
  if (facts.capacityAsk) return 'capacity-ask'
  if (facts.settingsOpen) return 'settings'
  if (facts.helpOpen === true) return 'help'
  if (facts.gitOffer) return 'git-offer'
  if (facts.contractAsk) return 'contract-ask'
  if (facts.managerCardArmed && facts.coordinatorFocused) return 'manager-card'
  return null
}

/** True exactly when a modal owns the keys screen-wide — the letter-verb
 *  and browse grammars must yield (the manager card's focus-scoped
 *  ownership included while the coordinator panel is focused). */
export function boardModalArmed(facts: BoardModalFactsV1): boolean {
  return boardModalOwner(facts) !== null
}

/**
 * FN-017 R1, route A — may a POINTER door arm `target` right now? A picker
 * arms only while no OTHER modal owns the keys (the predicate every
 * keyboard path yields on), or while it is itself the owner: its door is a
 * toggle, and the second click closes it. The pointer doors were unfenced:
 * a click on the rail's project chip opened the ground picker OVER a
 * standing seat-overload card, and Enter over the visible picker consented
 * to the hidden dispatch — Ink dispatches keys in MOUNT order, not paint
 * order, so the earlier-mounted card kept the key stream while the picker
 * was what the operator saw. PURE — the prover drives it.
 */
export function mayArmBoardModal(facts: BoardModalFactsV1, target: BoardModalOwnerV1): boolean {
  const owner = boardModalOwner(facts)
  return owner === null || owner === target
}

/**
 * FN-017 R1, route B — does the git offer's card own the keys right now?
 * The stacked mount (below 120 columns, or inside a split) is the screen's
 * LAST absolute sibling, so it painted above the model and ground pickers
 * while the owner table named the picker: arrows and Enter drove the
 * hidden picker under the card the operator saw, and Enter re-grounded the
 * harness with no visible cause. The stacked card paints exactly while the
 * table names it — it waits its turn under a picker and returns when the
 * picker closes. PURE.
 */
export function gitOfferOwnsTheKeys(facts: BoardModalFactsV1): boolean {
  return boardModalOwner(facts) === 'git-offer'
}
