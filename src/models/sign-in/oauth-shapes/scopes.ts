import { INFERENCE_SCOPE } from '../oauth/oauth.js'

const EXPIRY_BUFFER_MS = 5 * 60 * 1000

export function shouldUseClaudeAIAuth(scopes: string[] | undefined): boolean {
  return scopes?.includes(INFERENCE_SCOPE) ?? false
}

export function parseScopes(scopeString?: string | null): string[] {
  if (!scopeString) return []
  return scopeString.split(' ').filter(scope => scope !== '')
}

export function isOAuthTokenExpired(expiresAt: number | null): boolean {
  if (expiresAt === null) return false
  return Date.now() + EXPIRY_BUFFER_MS >= expiresAt
}
