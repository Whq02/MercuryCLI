import { useEffect, useState } from 'react'

import { signInLedgerEpoch, subscribeSignInEpoch } from './signInLedger.js'

export function useSignInEpoch(): number {
  const [epoch, setEpoch] = useState<number>(() => signInLedgerEpoch())
  useEffect(() => subscribeSignInEpoch(() => setEpoch(signInLedgerEpoch())), [])
  return epoch
}
