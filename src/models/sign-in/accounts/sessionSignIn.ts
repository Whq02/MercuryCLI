import { declaredRouteOf } from '../../roads/routeLaw.js'
import { notLoggedInGateDecision, walletEntries, type NotLoggedInGate } from '../../wallet/wallet.js'
import { isChooseAModel } from '../../catalogue/computedDefault.js'
import { sessionAccountFamily } from './sessionAccount.js'

export const NOT_SIGNED_IN_WORDS = 'not signed in'
export const SIGN_IN_COMMAND = '/logins'

export function sessionSignInGate(mainModel: string): NotLoggedInGate {
  const family = sessionAccountFamily(mainModel) ?? declaredRouteOf(mainModel)
  if (family === null && isChooseAModel(mainModel)) return { state: 'not-logged-in' }
  return notLoggedInGateDecision(walletEntries(), family)
}

export function signedOutStatusWords(gate: NotLoggedInGate): string | null {
  if (gate.state === 'not-logged-in') return `${NOT_SIGNED_IN_WORDS} · ${SIGN_IN_COMMAND}`
  if (gate.state === 'provider-missing') return `no ${gate.missingProvider} account · ${SIGN_IN_COMMAND}`
  return null
}
