import { subscribeSignInEpoch } from '../accounts/signInLedger.js'

const listeners = new Set<() => void>()
let ledgerArmed = false

export function noteCrewAccountChange(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
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

export { CREW_ACCOUNT_RESUME_NOTE } from '../../tasks/LocalAgentTask/agentPause.js'

export function crewAccountResumeSummary(name: string): string {
  return `${name} resumed by itself — the operator signed in on another account; its partial work carried forward`
}
