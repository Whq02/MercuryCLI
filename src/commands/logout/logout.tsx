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
import { clearScopeIdentitySnapshot, forgetScopeIdentity } from '../../utils/accounts/accountIdentity.js'
import { noteCredentialRemoval } from '../../utils/accounts/signInLedger.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import { clearToolSchemaCache } from '../../utils/toolSchemaCache.js'
import { resetUserCache } from '../../utils/user.js'

/**
 * Every auth-derived cache, exported separately for other auth-change paths.
 * The user-data cache resets BEFORE the feature-gate refresh so the refresh
 * picks up fresh credentials.
 */
export async function clearAuthRelatedCaches(): Promise<void> {
  clearOAuthTokenCache()
  clearBetasCaches()
  clearToolSchemaCache()
  resetUserCache()
  await refreshFeatureGates()
  await clearRemoteManagedSettingsCache()
  clearPolicyLimitsCache()
}

/**
 * The whole logout: server-side revoke first (a deleted local copy alone
 * leaves a still-valid token on the server), then local credential and
 * cache teardown, then the global-config reset.
 */
export async function performLogout({
  clearOnboarding = false,
}: { clearOnboarding?: boolean } = {}): Promise<void> {
  // Best-effort revoke, only when a refresh token exists; logout must
  // always complete.
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
  // The scope's own identity snapshot leaves with the login (the board's
  // verification heal writes it; a snapshot that outlives every credential
  // is the stale "signed in" row the next boot's board would paint), and
  // the resolved identity with it.
  clearScopeIdentitySnapshot(getMercuryHome())
  forgetScopeIdentity()

  // The ruled copy is the law: /logout signs out of ALL accounts, not the
  // Anthropic side alone — every engine family through the ONE per-slot
  // owner the /accounts board fires: the ChatGPT subscription, the
  // OAuth-minted OpenRouter key, the Google, Kimi and Hugging Face sign-ins,
  // and every stored key. Env-pinned keys are the shell's and stay.
  signOutEveryEngineCredential()

  // The signed-out account's usage truth (the window feeders) goes with the
  // credentials (lane IV) — BEFORE the cache
  // refresh below, whose network legs must not defer the reset.
  try {
    const { resetLimitsForCredentialSwitch } = await import('../../services/claudeAiLimits.js')
    resetLimitsForCredentialSwitch()
  } catch (error) {
    logError(error)
  }

  await clearAuthRelatedCaches()
  // The estate moved (every family): the epoch-keyed memos re-read and
  // every subscribed surface re-derives — the chip, the composer's account
  // row, the computed default — in this process, now.
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

/** Grace period so the confirmation is visible before the process ends. */
const SHUTDOWN_DELAY_MS = 200

export async function call(): Promise<React.ReactNode> {
  await performLogout({ clearOnboarding: true })
  setTimeout(() => {
    gracefulShutdownSync(0, 'logout')
  }, SHUTDOWN_DELAY_MS)
  return <Text>Logged out of all your accounts.</Text>
}
