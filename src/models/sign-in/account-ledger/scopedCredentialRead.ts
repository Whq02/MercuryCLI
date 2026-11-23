
import { clearAuthScope, getAuthScope, setAuthScope } from '../../../platform/environment/envUtils.js'
import { getSecureStorage } from '../../../platform/secure-storage/index.js'
import { clearKeychainCache } from '../../../platform/secure-storage/macOsKeychainHelpers.js'

interface AccountOAuthCreds {
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
}
