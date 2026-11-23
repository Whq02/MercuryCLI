import { passedOver } from '../../platform/errors/passedOver.js'
import { hostEnv } from '../../platform/environment/hostEnv.js'

export function isFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = hostEnv().ANTHROPIC_BASE_URL
  if (!baseUrl) return true
  try {
    return new URL(baseUrl).host === 'api.anthropic.com'
  } catch (error) {
    passedOver(error)
    return false
  }
}

export function hasAnthropicControlPlane(): boolean {
  return isFirstPartyAnthropicBaseUrl()
}
