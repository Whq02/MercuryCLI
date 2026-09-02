
import { clearAuthScope, getAuthScope, setAuthScope } from '../envUtils.js'
import { getSecureStorage } from '../secureStorage/index.js'
import { clearKeychainCache } from '../secureStorage/macOsKeychainHelpers.js'

export interface AccountOAuthCreds {
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
}

function withIsolatedAuthScope<T>(configDir: string, read: () => T): T {
  const prevScope = getAuthScope()
  try {
    setAuthScope(configDir)
    clearKeychainCache()
    return read()
  } finally {
    if (prevScope === undefined) clearAuthScope()
    else setAuthScope(prevScope)
    clearKeychainCache()
  }
}

export function readAccountOAuthCreds(configDir: string): AccountOAuthCreds | undefined {
  try {
    return withIsolatedAuthScope(configDir, () => {
      const oa = getSecureStorage().read()?.claudeAiOauth
      const token = oa?.accessToken
      if (typeof token !== 'string' || token.length === 0) return undefined
      return {
        accessToken: token,
        refreshToken:
          typeof oa?.refreshToken === 'string' && oa.refreshToken.length > 0
            ? oa.refreshToken
            : null,
        expiresAt: typeof oa?.expiresAt === 'number' ? oa.expiresAt : null,
      }
    })
  } catch {
    return undefined
  }
}
