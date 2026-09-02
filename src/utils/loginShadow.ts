// =============================================================================
// loginShadow — the account-switch 401 wedge, surfaced AT LOGIN TIME.
//
// When the session authenticates via an env token, the auth source chain ranks
// that token above the keychain (utils/auth.ts getAuthTokenSource), so a fresh
// /logins saves a credential the API will never use. The AVS friction audit
// measured the cost: three "Login successful" prints across a
// ~90-minute 401 wedge before the next-401 hint finally named the override.
//
// ONE predicate, shared by the 401-time hint (services/api/errors.ts) and
// every login-success surface (/logins, `mercury login`, ConsoleOAuthFlow),
// so the two moments can never disagree about which sources shadow a fresh
// login. Deliberately a LEAF module (zero imports) so
// scripts/accounts/prove-login-shadow.ts exercises the real functions.
// =============================================================================

/** Auth sources that OUTRANK a freshly-saved keychain login. */
export function isEnvShadowedAuthSource(source: string): boolean {
  return (
    source === 'MERCURY_OAUTH_TOKEN' ||
    source === 'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR'
  )
}

/**
 * The login-time warning for a just-saved login under `source`, or null when
 * the saved login is actually the live credential. Plain text — UI surfaces
 * add their own color; CLI surfaces print it verbatim.
 */
export function loginShadowWarningFor(source: string): string | null {
  if (!isEnvShadowedAuthSource(source)) return null
  return (
    `Warning: this session authenticates via the ${source} environment ` +
    `variable, which overrides the login you just saved — unset it (or ` +
    `restart Mercury without it) to use this login.`
  )
}
