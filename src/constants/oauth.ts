
type OauthConfig = {
  BASE_API_URL: string
  CONSOLE_AUTHORIZE_URL: string
  SUBSCRIPTION_AUTHORIZE_URL: string
  SUBSCRIPTION_ORIGIN: string
  TOKEN_URL: string
  API_KEY_URL: string
  ROLES_URL: string
  CONSOLE_SUCCESS_URL: string
  SUBSCRIPTION_SUCCESS_URL: string
  MANUAL_REDIRECT_URL: string
  CLIENT_ID: string
  MCP_PROXY_URL: string
  MCP_PROXY_PATH: string
}

const PRODUCTION_CONFIG: OauthConfig = {
  BASE_API_URL: 'https://api.anthropic.com',
  CONSOLE_AUTHORIZE_URL: 'https://platform.claude.com/oauth/authorize',
  SUBSCRIPTION_AUTHORIZE_URL: 'https://claude.com/cai/oauth/authorize',
  SUBSCRIPTION_ORIGIN: 'https://claude.ai',
  TOKEN_URL: 'https://platform.claude.com/v1/oauth/token',
  API_KEY_URL: 'https://api.anthropic.com/api/oauth/claude_cli/create_api_key',
  ROLES_URL: 'https://api.anthropic.com/api/oauth/claude_cli/roles',
  CONSOLE_SUCCESS_URL:
    'https://platform.claude.com/buy_credits?returnUrl=/oauth/code/success%3Fapp%3Dclaude-code',
  SUBSCRIPTION_SUCCESS_URL: 'https://platform.claude.com/oauth/code/success?app=claude-code',
  MANUAL_REDIRECT_URL: 'https://platform.claude.com/oauth/code/callback',
  CLIENT_ID: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  MCP_PROXY_URL: 'https://mcp-proxy.anthropic.com',
  MCP_PROXY_PATH: '/v1/mcp/{server_id}',
}

export const ANTHROPIC_CLIENT_CONTRACT_VERSION = '2.1.289'
export const ANTHROPIC_CLIENT_CONTRACT_AS_OF = '2026-10-04'

const CLIENT_CONTRACT_VERSION_SHAPE = /^\d+\.\d+\.\d+$/

export type AnthropicClientContract = {
  presented: string
  asOf: string
  source: 'constant' | 'learned' | 'override'
  ignoredOverride?: string
}

export function describeAnthropicClientContract(): AnthropicClientContract {
  const raw = process.env.MERCURY_ANTHROPIC_CLIENT_CONTRACT
  const override = raw === undefined ? '' : raw.trim()
  const asOf = ANTHROPIC_CLIENT_CONTRACT_AS_OF
  if (override !== '' && CLIENT_CONTRACT_VERSION_SHAPE.test(override)) return { presented: override, asOf, source: 'override' }
  const ignored = override === '' ? {} : { ignoredOverride: override }
  const { compareClientContractVersions, isoDay, learnedClientContract } =
    require('../services/api/clientContractLearned.js') as typeof import('../services/api/clientContractLearned.js')
  const learned = learnedClientContract()
  if (learned !== null && compareClientContractVersions(learned.version, ANTHROPIC_CLIENT_CONTRACT_VERSION) > 0) {
    return { presented: learned.version, asOf: isoDay(learned.learnedAtMs), source: 'learned', ...ignored }
  }
  return { presented: ANTHROPIC_CLIENT_CONTRACT_VERSION, asOf, source: 'constant', ...ignored }
}

export function getAnthropicClientContractVersion(): string {
  return describeAnthropicClientContract().presented
}

export const MCP_CLIENT_METADATA_URL = 'https://claude.ai/oauth/claude-code-client-metadata'

const CONSOLE_OAUTH_SCOPES = ['org:create_api_key', 'user:profile'] as const
export const SUBSCRIPTION_OAUTH_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
] as const

export const ALL_OAUTH_SCOPES: string[] = [
  ...new Set<string>([...CONSOLE_OAUTH_SCOPES, ...SUBSCRIPTION_OAUTH_SCOPES]),
]

export const INFERENCE_SCOPE = 'user:inference'
export const PROFILE_SCOPE = 'user:profile'
export const OAUTH_BETA_HEADER = 'oauth-2025-04-20'

export function isLoopbackOauthOrigin(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    const host = parsed.hostname.replace(/^\[|\]$/g, '')
    return host === '127.0.0.1' || host === '::1' || host === 'localhost'
  } catch {
    return false
  }
}

function pinnedOauthBase(): string | undefined {
  const raw = process.env.MERCURY_ANTHROPIC_OAUTH_BASE
  if (!raw) return undefined
  const base = raw.endsWith('/') ? raw.slice(0, -1) : raw
  return isLoopbackOauthOrigin(base) ? base : undefined
}

export function getOauthConfig(): OauthConfig {
  const config: OauthConfig = { ...PRODUCTION_CONFIG }
  const base = pinnedOauthBase()
  if (base !== undefined) {
    config.BASE_API_URL = base
    config.CONSOLE_AUTHORIZE_URL = `${base}/oauth/authorize`
    config.SUBSCRIPTION_AUTHORIZE_URL = `${base}/oauth/authorize`
    config.SUBSCRIPTION_ORIGIN = base
    config.TOKEN_URL = `${base}/v1/oauth/token`
    config.API_KEY_URL = `${base}/api/oauth/claude_cli/create_api_key`
    config.ROLES_URL = `${base}/api/oauth/claude_cli/roles`
    config.CONSOLE_SUCCESS_URL = `${base}/oauth/code/success?app=claude-code`
    config.SUBSCRIPTION_SUCCESS_URL = `${base}/oauth/code/success?app=claude-code`
    config.MANUAL_REDIRECT_URL = `${base}/oauth/code/callback`
  }
  const clientIdOverride = process.env.MERCURY_OAUTH_CLIENT_ID
  if (clientIdOverride) {
    config.CLIENT_ID = clientIdOverride
  }
  return config
}

export function anthropicAccountApiBase(): string {
  return process.env.ANTHROPIC_BASE_URL || getOauthConfig().BASE_API_URL
}
