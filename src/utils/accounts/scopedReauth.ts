
import { createHash, randomBytes } from 'node:crypto'
import {
  buildAuthUrl,
  exchangeCodeForTokens,
  parseScopes,
} from '../../services/oauth/client.js'
import { openBrowser } from '../browser.js'
import { saveOAuthTokensIfNeeded, clearOAuthTokenCache } from '../auth.js'
import { getAuthScope, setAuthScope, clearAuthScope } from '../envUtils.js'
import { recordSignIn } from './signInLedger.js'
import { logForDebugging } from '../debug.js'
import { healScopeIdentitySnapshot, forgetScopeIdentity } from './accountIdentity.js'
import { getOauthConfig } from '../../constants/oauth.js'

export interface PendingReauth {
  dir: string
  url: string
  state: string
  codeVerifier: string
  startedAt: number
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function startScopedReauth(
  dir: string,
  deps: { open?: (url: string) => Promise<boolean> } = {},
): Promise<PendingReauth> {
  const codeVerifier = base64url(randomBytes(32))
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest())
  const state = base64url(randomBytes(32))
  const url = buildAuthUrl({
    codeChallenge,
    state,
    port: 0,
    isManual: true,
    loginWithClaudeAi: true,
  })
  try {
    await (deps.open ?? openBrowser)(url)
  } catch {
  }
  return { dir, url, state, codeVerifier, startedAt: Date.now() }
}

export type ReauthOutcome =
  | { ok: true; email?: string }
  | { ok: false; reason: string }

export async function completeScopedReauth(
  pending: PendingReauth,
  pasted: string,
  deps: {
    exchange?: typeof exchangeCodeForTokens
    save?: typeof saveOAuthTokensIfNeeded
    fetchImpl?: typeof fetch
  } = {},
): Promise<ReauthOutcome> {
  const trimmed = pasted.trim()
  if (!trimmed) return { ok: false, reason: 'paste the code from the browser (code#state)' }
  const [code, pastedState] = trimmed.split('#')
  if (!code) return { ok: false, reason: 'no authorization code in the paste' }
  if (pastedState !== undefined && pastedState !== pending.state) {
    return { ok: false, reason: 'state mismatch — restart the reauth (stale or foreign link)' }
  }

  let tokens
  try {
    tokens = await (deps.exchange ?? exchangeCodeForTokens)(
      code,
      pending.state,
      pending.codeVerifier,
      0,
       true,
    )
  } catch (err) {
    return { ok: false, reason: `token exchange failed: ${(err as Error).message.slice(0, 120)}` }
  }

  const prevScope = getAuthScope()
  setAuthScope(pending.dir)
  clearOAuthTokenCache()
  try {
    const saved = (deps.save ?? saveOAuthTokensIfNeeded)({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      scopes: parseScopes(tokens.scope),
      subscriptionType: null,
      rateLimitTier: null,
    })
    if (!saved.success) {
      return { ok: false, reason: saved.warning ?? 'credential save failed (keychain locked?)' }
    }
    recordSignIn('anthropic', 'oauth')
  } finally {
    if (prevScope === undefined) clearAuthScope()
    else setAuthScope(prevScope)
    clearOAuthTokenCache()
  }

  let email: string | undefined
  try {
    const fetchImpl = deps.fetchImpl ?? fetch
    const response = await fetchImpl(`${getOauthConfig().BASE_API_URL}/api/oauth/profile`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(5_000),
    })
    if (response.ok) {
      const profile = (await response.json()) as {
        account?: { email_address?: string; email?: string; uuid?: string }
      }
      email = profile.account?.email_address ?? profile.account?.email
      if (email) {
        healScopeIdentitySnapshot(pending.dir, {
          email,
          ...(profile.account?.uuid !== undefined && { uuid: profile.account.uuid }),
        })
      }
    }
  } catch {
  }
  forgetScopeIdentity(pending.dir)
  logForDebugging(`[accounts] scoped reauth completed for ${pending.dir}${email ? ` (${email})` : ''}`)
  return { ok: true, ...(email !== undefined && { email }) }
}
