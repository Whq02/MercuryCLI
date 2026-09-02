import * as React from 'react'
import { Text } from '../../ink.js'
import { refreshFeatureGates } from '../../services/analytics/featureGates.js'
import { clearPolicyLimitsCache } from '../../services/policyLimits/index.js'
import { clearRemoteManagedSettingsCache } from '../../services/remoteManagedSettings/index.js'
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
import { signOutEveryEngineCredential } from '../../services/providers/accountSlots.js'
import { noteCredentialRemoval } from '../../utils/accounts/signInLedger.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import { clearToolSchemaCache } from '../../utils/toolSchemaCache.js'
import { resetUserCache } from '../../utils/user.js'

export async function clearAuthRelatedCaches(): Promise<void> {
  clearOAuthTokenCache()
  clearBetasCaches()
  clearToolSchemaCache()
  resetUserCache()
  await refreshFeatureGates()
  await clearRemoteManagedSettingsCache()
  clearPolicyLimitsCache()
}

export async function performLogout({
  clearOnboarding = false,
}: { clearOnboarding?: boolean } = {}): Promise<void> {
  try {
    const tokens = getClaudeAIOAuthTokens()
    if (tokens?.refreshToken) {
      await revokeOAuthToken(tokens.refreshToken)
    }
  } catch (error) {
    logError(error)
  }

  await removeApiKey()
  getSecureStorage().delete()

  signOutEveryEngineCredential()

  try {
    const { resetLimitsForCredentialSwitch } = await import('../../services/claudeAiLimits.js')
    resetLimitsForCredentialSwitch()
  } catch (error) {
    logError(error)
  }

  await clearAuthRelatedCaches()
  noteCredentialRemoval()

  saveGlobalConfig(current => {
    const next = { ...current, oauthAccount: undefined }
    if (clearOnboarding) {
      next.hasCompletedOnboarding = false
      next.subscriptionNoticeCount = 0
      next.hasAvailableSubscription = false
      if (next.customApiKeyResponses?.approved) {
        next.customApiKeyResponses = { ...next.customApiKeyResponses, approved: [] }
      }
    }
    return next
  })
}

const SHUTDOWN_DELAY_MS = 200

export async function call(): Promise<React.ReactNode> {
  await performLogout({ clearOnboarding: true })
  setTimeout(() => {
    gracefulShutdownSync(0, 'logout')
  }, SHUTDOWN_DELAY_MS)
  return <Text>Logged out of all your accounts.</Text>
}
