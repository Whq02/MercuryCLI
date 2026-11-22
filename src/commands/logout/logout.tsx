import * as React from 'react'
import { Text } from '../../ink.js'
import { revokeOAuthToken } from '../../services/oauth/client.js'
import { getClaudeAIOAuthTokens, removeApiKey } from '../../utils/auth.js'
import { clearOAuthTokenCache } from '../../services/auth/oauthLifecycle.js'
import { clearBetasCaches } from '../../utils/betas.js'
import { saveGlobalConfig } from '../../utils/config/globalConfig.js'
import { gracefulShutdownSync } from '../../utils/gracefulShutdown.js'
import { logError } from '../../utils/log.js'
import { credentialStoreLeftWords, deriveFamilySlotGroups, familiesRefusedIn, signOutEveryEngineCredential } from '../../services/providers/accountSlots.js'
import { clearScopeIdentitySnapshot, forgetScopeIdentity } from '../../utils/accounts/accountIdentity.js'
import { noteCredentialChange } from '../../utils/accounts/signInLedger.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { deleteCredentialStores } from '../../utils/secureStorage/index.js'
import { clearToolSchemaCache } from '../../utils/toolSchemaCache.js'
import { resetUserCache } from '../../utils/user.js'
import { startTimeout } from '../../utils/timers.js'
import { notBuilt } from '../../pi/holes.js'

export async function performLogout(arg0?: { clearOnboarding?: boolean }): Promise<string[]> {
  return notBuilt('src/commands/logout/logout.tsx:26')
}

function signedInSlots(): Map<string, string> {
  try {
    return new Map(deriveFamilySlotGroups().flatMap(group => group.slots).filter(slot => slot.signedIn).map(slot => [slot.id, slot.family]))
  } catch (error) {
    logError(error)
    return new Map()
  }
}

export async function signOutRefusals(options: { clearOnboarding?: boolean } = {}): Promise<string[]> {
  const before = signedInSlots()
  const refused = await performLogout(options)
  if (refused.length === 0) return refused
  const after = signedInSlots()
  const refusedFamilies = familiesRefusedIn(refused)
  const othersSignedOut = refusedFamilies !== null && [...before].some(([id, family]) => !after.has(id) && !refusedFamilies.includes(family))
  return othersSignedOut ? [...refused, 'The other providers are signed out.'] : refused
}

const SHUTDOWN_DELAY_MS = 200

export async function call(): Promise<React.ReactNode> {
  const refused = await signOutRefusals({ clearOnboarding: true })
  startTimeout(() => {
    if (refused.length > 0) gracefulShutdownSync(1, 'logout', { finalMessage: refused.join('\n') })
    else gracefulShutdownSync(0, 'logout')
  }, SHUTDOWN_DELAY_MS)
  return <Text>{refused.length > 0 ? refused.join('\n') : 'Logged out of all your accounts.'}</Text>
}
