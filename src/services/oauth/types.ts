
type LiteralOrString<T extends string> = T | (string & {})


export type SubscriptionType = 'max' | 'pro' | 'enterprise' | 'team'

export type RateLimitTier = LiteralOrString<
  'default' | 'default_claude_max_5x' | 'default_claude_max_20x'
>

export type BillingType = LiteralOrString<
  'stripe' | 'invoice' | 'free' | 'unknown'
>


export interface OAuthTokenAccount {
  uuid: string
  email_address: string
}

export interface OAuthTokenOrganization {
  uuid: string
}

export interface OAuthTokens {
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  scopes: string[]
  subscriptionType: SubscriptionType | null
  rateLimitTier: RateLimitTier | null
  profile?: OAuthProfileResponse
  tokenAccount?: {
    uuid: string
    emailAddress: string
    organizationUuid?: string
  }
}

export interface OAuthTokenExchangeResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  scope?: string
  account?: OAuthTokenAccount
  organization?: OAuthTokenOrganization
}


export interface OAuthProfileAccount {
  uuid: string
  email: string
  display_name: string
  created_at: string
  has_claude_max?: boolean
  has_claude_pro?: boolean
}

export interface OAuthProfileOrganization {
  uuid: string
  organization_type?: LiteralOrString<
    'claude_max' | 'claude_pro' | 'claude_enterprise' | 'claude_team'
  >
  rate_limit_tier?: RateLimitTier | null
  billing_type?: BillingType | null
  subscription_created_at?: string | null
}

export interface OAuthProfileResponse {
  account: OAuthProfileAccount
  organization: OAuthProfileOrganization
}


export interface UserRolesResponse {
  organization_role: string | null
  workspace_role: string | null
  organization_name: string | null
}
