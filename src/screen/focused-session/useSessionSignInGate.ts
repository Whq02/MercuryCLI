import { useMemo } from 'react'
import type { NotLoggedInGate } from '../../models/wallet/wallet.js'
import { useSignInEpoch } from '../../models/sign-in/account-ledger/useSignInEpoch.js'
import { sessionSignInGate } from '../../models/sign-in/accounts/sessionSignIn.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { useCatalogueEpoch } from '../model-picker/useCatalogueEpoch.js'

const OK: NotLoggedInGate = { state: 'ok' }

export function useSessionSignInGate(mainModel: string): NotLoggedInGate {
  const signInEpoch = useSignInEpoch()
  const catalogueEpoch = useCatalogueEpoch()
  return useMemo((): NotLoggedInGate => {
    void signInEpoch
    void catalogueEpoch
    try {
      return sessionSignInGate(mainModel)
    } catch (error) {
      passedOver(error)
      return OK
    }
  }, [mainModel, signInEpoch, catalogueEpoch])
}
