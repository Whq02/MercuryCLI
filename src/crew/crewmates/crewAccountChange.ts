import { subscribeSignInEpoch } from '../../models/sign-in/account-ledger/signInLedger.js'
import { passedOver } from '../../platform/errors/passedOver.js'

const listeners = new Set<() => void>()
let ledgerArmed = false

export function noteCrewAccountChange(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      passedOver(error)
      continue
    }
  }
}

export function subscribeCrewAccountChange(listener: () => void): () => void {
  if (!ledgerArmed) {
    ledgerArmed = true
    subscribeSignInEpoch(() => noteCrewAccountChange())
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export { CREW_ACCOUNT_RESUME_NOTE } from '../../engine/tasks/local-agent/crewmatePause.js'

export function crewAccountResumeSummary(name: string): string {
  return `${name} resumed by itself — the operator signed in on another account; its partial work carried forward`
}
