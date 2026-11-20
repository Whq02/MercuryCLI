import * as React from 'react'
import { Text } from '../../ink.js'
import { revokeOAuthToken } from '../../services/oauth/client.js'
import {
  clearOAuthTokenCache,
  getClaudeAIOAuthTokens,
  removeApiKey,
} from '../../utils/auth.js'
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

function clearAuthRelatedCaches(): void {
  clearOAuthTokenCache()
  clearBetasCaches()
  clearToolSchemaCache()
  resetUserCache()
}

export async function performLogout({
  clearOnboarding = false,
}: { clearOnboarding?: boolean } = {}): Promise<string[]> {
  try {
    const tokens = getClaudeAIOAuthTokens()
    if (tokens?.refreshToken) {
      await revokeOAuthToken(tokens.refreshToken)
    }
  } catch (error) {
    logError(error)
  }

  const storesLeft: string[] = []
  try {
    await removeApiKey()
  } catch (error) {
    logError(error)
    storesLeft.push(`Could not sign out: ${error instanceof Error ? error.message : String(error)}`)
  }
  for (const where of deleteCredentialStores()) storesLeft.push(`Could not sign out: ${credentialStoreLeftWords(where)}`)
  clearScopeIdentitySnapshot(getMercuryHome())
  forgetScopeIdentity()

  const refused = [...signOutEveryEngineCredential(), ...storesLeft]

  try {
    const { resetLimitsForCredentialSwitch } = await import('../../services/anthropicLimits.js')
    resetLimitsForCredentialSwitch()
  } catch (error) {
    logError(error)
  }

  clearAuthRelatedCaches()
  noteCredentialChange()

  saveGlobalConfig(current => {
    const next = { ...current, oauthAccount: undefined }
    if (clearOnboarding) {
      next.hasCompletedOnboarding = false
      if (next.customApiKeyResponses?.approved) {
        next.customApiKeyResponses = { ...next.customApiKeyResponses, approved: [] }
      }
    }
    return next
  })
  return refused
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
