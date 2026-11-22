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
import { notBuilt } from '../pi/holes.js'

function hasResolvableApiKey(): boolean {
  try {
    return getAnthropicApiKey() !== null
  } catch (error) {
    passedOver(error)
    return false
  }
}

export function hasConsoleBillingAccess(): boolean {
  return notBuilt('src/utils/billing.ts:21')
}

export function hasClaudeAiBillingAccess(): boolean {
  return notBuilt('src/utils/billing.ts:37')
}
