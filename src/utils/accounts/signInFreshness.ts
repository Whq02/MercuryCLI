import { isOAuthTokenExpired } from '../../services/oauth/client.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getAuthTokenSource,
  getClaudeAIOAuthTokens,
  invalidateOnDiskChange,
  isAnthropicOAuthSignInExpired,
} from '../auth.js'
import { noteCredentialChange } from './signInLedger.js'

type SignInFamily = 'anthropic' | 'openai'

type SignInFreshness = {
  family: SignInFamily
  state: 'valid' | 'expired' | 'absent' | 'unknown'
  probed: boolean
}

function expiredSignInFamilies(checks: readonly SignInFreshness[]): SignInFamily[] {
  return checks.filter(check => check.state === 'expired').map(check => check.family)
}

export async function checkAnthropicSignInFresh(): Promise<SignInFreshness> {
  const family = 'anthropic' as const
  try {
    invalidateOnDiskChange()
    const tokens = getClaudeAIOAuthTokens()
    if (!tokens || getAuthTokenSource().source !== 'claude.ai') return { family, state: 'absent', probed: false }
    if (isAnthropicOAuthSignInExpired()) return { family, state: 'expired', probed: false }
    if (!isOAuthTokenExpired(tokens.expiresAt)) return { family, state: 'valid', probed: false }
    const refreshed = await checkAndRefreshOAuthTokenIfNeeded()
    if (refreshed) return { family, state: 'valid', probed: true }
    if (isAnthropicOAuthSignInExpired()) {
      noteCredentialChange()
      return { family, state: 'expired', probed: true }
    }
    invalidateOnDiskChange()
    const now = getClaudeAIOAuthTokens()
    if (now && !isOAuthTokenExpired(now.expiresAt)) return { family, state: 'valid', probed: true }
    return { family, state: 'unknown', probed: true }
  } catch {
    return { family, state: 'unknown', probed: false }
  }
}

export async function checkOpenaiSignInFresh(): Promise<SignInFreshness> {
  const family = 'openai' as const
  try {
    const openai = await import('../../services/providers/openai/openaiAccounts.js')
    const before = openai.openaiSubscriptionPresence()
    if (before.state === 'absent') return { family, state: 'absent', probed: false }
    if (before.state === 'expired') return { family, state: 'expired', probed: false }
    if (openai.openaiSubscriptionTokenFresh()) return { family, state: 'valid', probed: false }
    const tokens = await openai.currentSubscriptionTokens()
    if (tokens !== undefined) return { family, state: 'valid', probed: true }
    if (openai.openaiSubscriptionPresence().state === 'expired') {
      noteCredentialChange()
      return { family, state: 'expired', probed: true }
    }
    return { family, state: 'unknown', probed: true }
  } catch {
    return { family, state: 'unknown', probed: false }
  }
}

async function checkSignInsFresh(): Promise<SignInFreshness[]> {
  return Promise.all([checkAnthropicSignInFresh(), checkOpenaiSignInFresh()])
}

let bootCheck: Promise<SignInFreshness[]> | null = null

export function signInsCheckedAtOpen(): Promise<SignInFreshness[]> {
  bootCheck ??= checkSignInsFresh()
  return bootCheck
}

function __resetSignInsCheckedAtOpenForTest(): void {
  bootCheck = null
}
