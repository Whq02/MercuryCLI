import { flagEnabled } from '../substrate/flagRegistry.js'
import {
  getAnthropicApiKey,
  getAuthTokenSource,
  getOauthAccountInfo,
  getSubscriptionType,
  isClaudeAISubscriber,
} from './auth.js'
import { getGlobalConfig } from './config/globalConfig.js'
import { passedOver } from './passedOver.js'

function hasResolvableApiKey(): boolean {
  try {
    return getAnthropicApiKey() !== null
  } catch (error) {
    passedOver(error)
    return false
  }
}

export function hasConsoleBillingAccess(): boolean {
  if (!flagEnabled('MERCURY_COST_WARNINGS') || isClaudeAISubscriber()) return false
  if (!getAuthTokenSource().hasToken && !hasResolvableApiKey()) return false
  const account = getGlobalConfig().oauthAccount
  if (!account?.organizationRole || !account.workspaceRole) return false
  return account.organizationRole === 'admin' || account.organizationRole === 'billing' ||
    account.workspaceRole === 'workspace_admin' || account.workspaceRole === 'workspace_billing'
}

export function hasClaudeAiBillingAccess(): boolean {
  if (!isClaudeAISubscriber()) return false
  const type = getSubscriptionType()
  if (type === 'max' || type === 'pro') return true
  const role = getOauthAccountInfo()?.organizationRole
  return role === 'admin' || role === 'billing' || role === 'owner' || role === 'primary_owner'
}
