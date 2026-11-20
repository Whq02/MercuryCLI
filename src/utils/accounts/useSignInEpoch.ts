import { useState } from 'react'
import { useSubscription } from '../../hooks/effects.js'

import { signInLedgerEpoch, subscribeSignInEpoch } from './signInLedger.js'

export function useSignInEpoch(): number {
  const [epoch, setEpoch] = useState<number>(() => signInLedgerEpoch())
  useSubscription(() => subscribeSignInEpoch(() => setEpoch(signInLedgerEpoch())), [])
  return epoch
}
