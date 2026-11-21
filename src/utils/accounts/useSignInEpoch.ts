import { useSyncExternalStore } from 'react'

import { signInLedgerEpoch, subscribeSignInEpoch } from './signInLedger.js'

export function useSignInEpoch(): number {
  return useSyncExternalStore(subscribeSignInEpoch, signInLedgerEpoch, signInLedgerEpoch)
}
