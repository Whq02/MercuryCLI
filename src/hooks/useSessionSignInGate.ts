import { useMemo } from 'react'
import type { NotLoggedInGate } from '../services/wallet/wallet.js'
import { useSignInEpoch } from '../utils/accounts/useSignInEpoch.js'
import { sessionSignInGate } from '../utils/accounts/sessionSignIn.js'
import { useCatalogueEpoch } from './useCatalogueEpoch.js'

const OK: NotLoggedInGate = { state: 'ok' }

export function useSessionSignInGate(mainModel: string): NotLoggedInGate {
  const signInEpoch = useSignInEpoch()
  const catalogueEpoch = useCatalogueEpoch()
  return useMemo((): NotLoggedInGate => {
    void signInEpoch
    void catalogueEpoch
    try {
      return sessionSignInGate(mainModel)
    } catch {
      return OK
    }
  }, [mainModel, signInEpoch, catalogueEpoch])
}
