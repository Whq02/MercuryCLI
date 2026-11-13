
export interface BoardModalFactsV1 {
  capacityAsk: boolean
  trustAsk: boolean
  settingsOpen?: boolean
  groundPickerOpen: boolean
  rowPick: boolean
  gitOffer: boolean
  contractAsk: boolean
  helpOpen?: boolean
  modelDefault?: boolean
}

export type BoardModalOwnerV1 =
  | 'model-default'
  | 'capacity-ask'
  | 'trust-ask'
  | 'settings'
  | 'ground-picker'
  | 'row-pick'
  | 'git-offer'
  | 'contract-ask'
  | 'help'

export function boardModalOwner(facts: BoardModalFactsV1): BoardModalOwnerV1 | null {
  if (facts.modelDefault === true) return 'model-default'
  if (facts.rowPick) return 'row-pick'
  if (facts.trustAsk) return 'trust-ask'
  if (facts.groundPickerOpen) return 'ground-picker'
  if (facts.capacityAsk) return 'capacity-ask'
  if (facts.settingsOpen === true) return 'settings'
  if (facts.helpOpen === true) return 'help'
  if (facts.gitOffer) return 'git-offer'
  if (facts.contractAsk) return 'contract-ask'
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
