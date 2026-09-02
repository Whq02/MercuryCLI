// ============================================================================
//  utils/accounts/scopedCredentialRead — the audited, isolated credential
//  read for ONE login scope. THE ONLY code in the tree that reads a config
//  dir's OAuth tokens outside the live auth chain; isolated here so the
//  credential boundary stays auditable in one file.
//
//  Consumer: the /accounts board's live identity verification
//  (accountIdentity.ts) — the token is used solely as a Bearer header
//  against the OAuth profile endpoint and never returned to display code.
//
//  SAFETY FLOOR (hard invariants — diff-read this):
//   • Nothing token-shaped is logged, rendered, persisted, or returned
//     beyond the typed creds object handed to the one consumer.
//   • The read is ISOLATED: a synchronous auth-scope bracket with
//     clearKeychainCache() on BOTH sides, so one scope's blob can never
//     leak into the process-wide keychain cache under another's name. The
//     whole bracket is synchronous — no other read interleaves.
//   • A miss (no creds, locked keychain, parse failure) is a STATE, never
//     a throw — callers degrade to the honest signed-out answer.
// ============================================================================

import { clearAuthScope, getAuthScope, setAuthScope } from '../envUtils.js'
import { getSecureStorage } from '../secureStorage/index.js'
import { clearKeychainCache } from '../secureStorage/macOsKeychainHelpers.js'

/** Full non-inference OAuth creds for one scope. Handled ONLY inside the
 *  bracket below and by the identity verifier; never logged or shown. */
export interface AccountOAuthCreds {
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
}

/**
 * Run `read` with the credential store isolated to `configDir`, synchronously.
 *
 * The store resolves via getAuthConfigHomeDir() (auth-scope aware), so the
 * isolation is done by temporarily SETTING the auth scope to `configDir` —
 * stacking and restoring any prior scope. clearKeychainCache() on BOTH sides
 * so the process-wide keychain blob can never cross scopes. Fully synchronous
 * (sync `security` spawn) ⇒ nothing interleaves between set → read → restore.
 */
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

/**
 * Read ONE scope's FULL OAuth creds (accessToken + refreshToken + expiresAt)
 * from its config dir, in isolation. Returns undefined on any miss — a state,
 * not an error.
 */
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
