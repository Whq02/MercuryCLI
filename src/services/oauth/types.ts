// =============================================================================
// services/oauth/types.ts — the shared OAuth / subscription API contract
//
// This type-only module had no on-disk source: it is imported `import type`
// from the oauth service (client.ts / index.ts / getOauthProfile.ts), the auth
// + config layers (utils/auth.ts, utils/config.ts, secureStorage), the MCP auth
// path and the mock-rate-limits harness.
// The bundler elided the missing import (so the build stayed green) but strict
// `tsc` raised TS2307/TS2305 at every site.
//
// It is reconstructed here from the IN-REPO usage (the oracle): every field is
// grounded in a real property access, union narrowing, switch case, or `??`
// fallback in a consumer. Type-only: stripped at build, zero runtime cost.
//
// Producers / consumers that pin these shapes:
//   • services/oauth/client.ts      — refreshOAuthToken / fetchProfileInfo /
//                                      fetchAndStoreUserRoles / exchangeCodeForTokens
//   • services/oauth/index.ts       — OAuthService.formatTokens / startOAuthFlow
//   • services/oauth/getOauthProfile.ts — axios.get<OAuthProfileResponse>(...)
//   • utils/auth.ts                 — OAuthTokens field access, SubscriptionType
//                                      switch + isConsumerPlan narrowing
//   • utils/secureStorage/types.ts  — SecureStorageData.claudeAiOauth
//   • cli/handlers/auth.ts          — installOAuthTokens(tokens: OAuthTokens)
//   • services/mockRateLimits.ts    — SubscriptionType mock
//   • services/api/referral.ts      — referral campaign / eligibility / redemptions
// =============================================================================

/**
 * A string literal that also accepts any other string at assignment without
 * collapsing to a bare `string` (so known values still autocomplete and don't
 * trip TS2367 "no overlap" on `===` comparisons against the literal). The OAuth
 * server returns an open, server-controlled set for these fields, so a closed
 * union would be both inaccurate and a future-break risk.
 */
type LiteralOrString<T extends string> = T | (string & {})

//
// Subscription / plan
//

/**
 * The Claude subscription plan a token grants. Closed union: utils/auth.ts
 * narrows it (`isConsumerPlan(plan): plan is 'max' | 'pro'`) and switches over
 * all four cases (`getSubscriptionName`), and client.ts maps the org's
 * `organization_type` onto exactly these. `null` everywhere = API / unknown.
 */
export type SubscriptionType = 'max' | 'pro' | 'enterprise' | 'team'

/**
 * The rate-limit tier string the backend assigns (e.g. `default_claude_max_20x`,
 * `default_claude_max_5x`, `default`). Consumers compare it against specific
 * literals AND read it through `getRateLimitTier(): string | null`, so it must
 * stay assignable to `string` while keeping the known literals for autocomplete.
 */
export type RateLimitTier = LiteralOrString<
  'default' | 'default_claude_max_5x' | 'default_claude_max_20x'
>

/**
 * How the org is billed. Stored verbatim onto `AccountInfo.billingType`
 * (`BillingType | null`); never compared against a literal in-repo, and the
 * server owns the value space, so it is modeled as an open branded string.
 */
export type BillingType = LiteralOrString<
  'stripe' | 'invoice' | 'free' | 'unknown'
>

//
// OAuth tokens (the persisted credential)
//

/** The token-exchange `account` block (snake_case wire shape). */
export interface OAuthTokenAccount {
  uuid: string
  email_address: string
}

/** The token-exchange `organization` block (snake_case wire shape). */
export interface OAuthTokenOrganization {
  uuid: string
}

/**
 * The locally-persisted OAuth credential (camelCase; written to secure storage
 * as `claudeAiOauth`). Built by `OAuthService.formatTokens` and
 * `refreshOAuthToken`, read across utils/auth.ts.
 */
export interface OAuthTokens {
  accessToken: string
  /** null for env-var / file-descriptor tokens (no refresh available). */
  refreshToken: string | null
  /** Epoch ms; null for non-expiring inference tokens. */
  expiresAt: number | null
  scopes: string[]
  subscriptionType: SubscriptionType | null
  rateLimitTier: RateLimitTier | null
  /** The raw profile response cached at acquisition, if it was fetched. */
  profile?: OAuthProfileResponse
  /** Account info from the token-exchange response (profile-endpoint fallback). */
  tokenAccount?: {
    uuid: string
    emailAddress: string
    organizationUuid?: string
  }
}

/**
 * The raw `POST {TOKEN_URL}` (authorization_code / refresh_token grant) wire
 * response. `account` / `organization` are optional — older grants omit them.
 * Field access: `access_token`, `refresh_token`, `expires_in`, `scope`,
 * `account.uuid`, `account.email_address`, `organization?.uuid`.
 */
export interface OAuthTokenExchangeResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  scope?: string
  account?: OAuthTokenAccount
  organization?: OAuthTokenOrganization
}

//
// OAuth profile (GET /api/oauth/profile, /api/claude_cli_profile)
//

/** The `account` object on an OAuth profile response. */
export interface OAuthProfileAccount {
  uuid: string
  email: string
  /** May be empty/falsy — consumers guard with `||`/truthiness before use. */
  display_name: string
  created_at: string
  /** Surfaced for the "switch to existing subscription" notification. */
  has_claude_max?: boolean
  has_claude_pro?: boolean
}

/** The `organization` object on an OAuth profile response. */
export interface OAuthProfileOrganization {
  uuid: string
  /** Mapped onto SubscriptionType in client.ts (the four `claude_*` orgs). */
  organization_type?: LiteralOrString<
    'claude_max' | 'claude_pro' | 'claude_enterprise' | 'claude_team'
  >
  rate_limit_tier?: RateLimitTier | null
  billing_type?: BillingType | null
  subscription_created_at?: string | null
}

/**
 * The full profile response. Every nested field is read through optional
 * chaining in the consumers, so `account` / `organization` are required objects
 * but their members carry the nullability the call sites assume.
 */
export interface OAuthProfileResponse {
  account: OAuthProfileAccount
  organization: OAuthProfileOrganization
}

//
// User roles (GET {ROLES_URL})
//

/**
 * The roles response stored onto the oauth account. Read in
 * `fetchAndStoreUserRoles`: `organization_role`, `workspace_role`,
 * `organization_name` (all persisted onto AccountInfo, which types them as
 * `string | null`).
 */
export interface UserRolesResponse {
  organization_role: string | null
  workspace_role: string | null
  organization_name: string | null
}

// (The referral / guest-passes wire types DIED with the /passes depromotion
// the surface had no Mercury function.)
//

