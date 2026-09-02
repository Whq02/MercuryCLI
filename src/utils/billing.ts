import {
  getAnthropicApiKey,
  getAuthTokenSource,
  getOauthAccountInfo,
  getSubscriptionType,
  isClaudeAISubscriber,
} from './auth.js'
import { getGlobalConfig } from './config/globalConfig.js'
import { isEnvTruthy } from './envUtils.js'

/** The API-key arm of the has-any-authentication test: the resolver's
 *  CI/test no-credential throw is swallowed and read as "no key". */
function hasResolvableApiKey(): boolean {
  try {
    return getAnthropicApiKey() !== null
  } catch {
    return false
  }
}

/**
 * Whether console-billing surfaces (cost warnings, spend views) apply to
 * this account. An account that last signed in before roles were recorded
 * carries neither role and is treated as having no billing access rather
 * than guessed at.
 */
export function hasConsoleBillingAccess(): boolean {
  if (isEnvTruthy(process.env.DISABLE_COST_WARNINGS)) return false
  if (isClaudeAISubscriber()) return false
  // "Any authentication" comes from the token-source accessor (it covers
  // env-token and helper-based sources too), OR'd with API-key presence.
  if (!getAuthTokenSource().hasToken && !hasResolvableApiKey()) return false
  // The role checks read the GLOBAL CONFIG's stored OAuth account record
  // directly, not the auth-scope-aware accessor.
  const account = getGlobalConfig().oauthAccount
  const organizationRole = account?.organizationRole
  const workspaceRole = account?.workspaceRole
  if (!organizationRole || !workspaceRole) return false
  return (
    organizationRole === 'admin' ||
    organizationRole === 'billing' ||
    workspaceRole === 'workspace_admin' ||
    workspaceRole === 'workspace_billing'
  )
}

// Settable override used by the rate-limit mocking command; a non-null value
// wins outright.
let mockBillingAccessOverride: boolean | null = null

export function setMockBillingAccessOverride(value: boolean | null): void {
  mockBillingAccessOverride = value
}

/**
 * Whether subscription-billing surfaces apply. Consumer plans always
 * qualify; team/enterprise (and anything unrecognised) qualify through the
 * organization role.
 */
export function hasClaudeAiBillingAccess(): boolean {
  if (mockBillingAccessOverride !== null) return mockBillingAccessOverride
  if (!isClaudeAISubscriber()) return false
  const subscriptionType = getSubscriptionType()
  if (subscriptionType === 'max' || subscriptionType === 'pro') return true
  const organizationRole = getOauthAccountInfo()?.organizationRole
  return (
    organizationRole === 'admin' ||
    organizationRole === 'billing' ||
    organizationRole === 'owner' ||
    organizationRole === 'primary_owner'
  )
}
