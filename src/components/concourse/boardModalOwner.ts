
export interface BoardModalFactsV1 {
  capacityAsk: boolean
  trustAsk: boolean
  settingsOpen: boolean
  groundPickerOpen: boolean
  rowPick: boolean
  seatAsk: boolean
  gitOffer: boolean
  contractAsk: boolean
  managerSeatAsk: boolean
  managerCardArmed: boolean
  coordinatorFocused: boolean
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

export function boardModalArmed(facts: BoardModalFactsV1): boolean {
  return boardModalOwner(facts) !== null
}

export function mayArmBoardModal(facts: BoardModalFactsV1, target: BoardModalOwnerV1): boolean {
  const owner = boardModalOwner(facts)
  return owner === null || owner === target
}

export function gitOfferOwnsTheKeys(facts: BoardModalFactsV1): boolean {
  return boardModalOwner(facts) === 'git-offer'
}
