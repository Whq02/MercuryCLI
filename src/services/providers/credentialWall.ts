
export type CredentialWallCause = 'sign-in' | 'key-limit'


const REVOKED_SIGN_IN = /\btoken\b[^.{}"]{0,40}?\brevoked\b|\brevoked\b[^.{}"]{0,20}?\btoken\b/i
const KEY_LIMIT = /\bkey\b[^.{}"]{0,40}?\b(?:limit|cap|quota)\b[^.{}"]{0,30}?\b(?:exceeded|reached|hit)\b/i

const WALL_STATUSES = new Set([401, 402, 403])

export function isRevokedSignInText(wireText: string): boolean {
  return REVOKED_SIGN_IN.test(wireText)
}

export function isKeyLimitText(wireText: string): boolean {
  return KEY_LIMIT.test(wireText)
}

export function classifyCredentialWall(
  status: number | undefined,
  wireText: string,
): CredentialWallCause | undefined {
  if (status === undefined || !WALL_STATUSES.has(status)) return undefined
  if (REVOKED_SIGN_IN.test(wireText)) return 'sign-in'
  if (KEY_LIMIT.test(wireText)) return 'key-limit'
  return undefined
}

const LOGINS_FAMILY_WORDS = new Set(['anthropic', 'openai', 'openrouter', 'gemini', 'huggingface', 'moonshot', 'zai', 'deepseek'])

export function reconnectDoorFor(route: string): string {
  if (LOGINS_FAMILY_WORDS.has(route)) return `/logins ${route}`
  if (route === 'openai-compat') return '/router key compat'
  if (route === 'local') return '/router key local'
  return '/logins'
}

function displayNameOf(route: string): string {
  try {
    const { providerDisplayName } = require('./routeLaw.js') as typeof import('./routeLaw.js')
    return providerDisplayName(route)
  } catch {
    return route
  }
}

export function credentialWallLine(
  route: string,
  cause: CredentialWallCause,
  opts?: { nonInteractive?: boolean },
): string {
  const name = displayNameOf(route)
  const door = reconnectDoorFor(route)
  const state = cause === 'sign-in' ? 'sign-in expired' : 'key limit reached'
  const reconnect = cause === 'sign-in' ? 'reconnect' : 'connect another key'
  if (opts?.nonInteractive === true) {
    return `${name} ${state} — switch providers (--model) or ${reconnect} (${door}, in an interactive session)`
  }
  return `${name} ${state} — switch providers (/model) or ${reconnect} (${door})`
}

export function observedCredentialWall(route: string): CredentialWallCause | undefined {
  try {
    if (route === 'anthropic') {
      const { isAnthropicOAuthSignInExpired } = require('../../utils/auth.js') as typeof import('../../utils/auth.js')
      return isAnthropicOAuthSignInExpired() ? 'sign-in' : undefined
    }
    if (route === 'openrouter') {
      const { openrouterObservedKeyUsage } =
        require('./openrouter/openrouterUsageState.js') as typeof import('./openrouter/openrouterUsageState.js')
      const usage = openrouterObservedKeyUsage().usage
      if (
        usage !== null &&
        typeof usage.limit === 'number' &&
        typeof usage.limitRemaining === 'number' &&
        usage.limitRemaining <= 0
      ) {
        return 'key-limit'
      }
      const { laneBillingState } = require('./laneBillingState.js') as typeof import('./laneBillingState.js')
      const billing = laneBillingState('openrouter')
      if (billing.state === 'credit-exhausted' && KEY_LIMIT.test(billing.detail)) return 'key-limit'
    }
  } catch {
  }
  return undefined
}

export function credentialWallLineForModel(modelId: string | undefined): string | undefined {
  if (modelId === undefined || modelId.trim() === '') return undefined
  try {
    const { declaredRouteOf } = require('./routeLaw.js') as typeof import('./routeLaw.js')
    const route = declaredRouteOf(modelId)
    if (route === null) return undefined
    const cause = observedCredentialWall(route)
    return cause === undefined ? undefined : credentialWallLine(route, cause)
  } catch {
    return undefined
  }
}
