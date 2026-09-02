import { useEffect, useState } from 'react'

import { signInLedgerEpoch, subscribeSignInEpoch } from './signInLedger.js'

/**
 * The sign-in ledger's epoch as component state: a surface keyed on it
 * re-derives the moment a credential lands or leaves in this process (a
 * chat's /logins, a board sign-out, /logout) — no new session, no restart.
 * The initial value is the live epoch, so a component mounting after a
 * sign-in already reads the moved estate.
 */
export function useSignInEpoch(): number {
  const [epoch, setEpoch] = useState<number>(() => signInLedgerEpoch())
  useEffect(() => subscribeSignInEpoch(() => setEpoch(signInLedgerEpoch())), [])
  return epoch
}
