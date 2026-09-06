import { flagEnabled } from '../substrate/flagRegistry.js'
import {
  getAnthropicApiKey,
  getAuthTokenSource,
  getOauthAccountInfo,
  getSubscriptionType,
  isClaudeAISubscriber,
} from './auth.js'
import { getGlobalConfig } from './config/globalConfig.js'

function hasResolvableApiKey(): boolean {
  try {
    return getAnthropicApiKey() !== null
  } catch {
    return false
  }
}

export function hasConsoleBillingAccess(): boolean {
  if (!flagEnabled('MERCURY_COST_WARNINGS')) return false
  if (isClaudeAISubscriber()) return false
  if (!getAuthTokenSource().hasToken && !hasResolvableApiKey()) return false
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

let mockBillingAccessOverride: boolean | null = null

export function setMockBillingAccessOverride(value: boolean | null): void {
  mockBillingAccessOverride = value
}

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
