
type OauthConfig = {
  BASE_API_URL: string
  CONSOLE_AUTHORIZE_URL: string
  CLAUDE_AI_AUTHORIZE_URL: string
  CLAUDE_AI_ORIGIN: string
  TOKEN_URL: string
  API_KEY_URL: string
  ROLES_URL: string
  CONSOLE_SUCCESS_URL: string
  CLAUDEAI_SUCCESS_URL: string
  MANUAL_REDIRECT_URL: string
  CLIENT_ID: string
  OAUTH_FILE_SUFFIX: string
  MCP_PROXY_URL: string
  MCP_PROXY_PATH: string
}

const PRODUCTION_CONFIG: OauthConfig = {
  BASE_API_URL: 'https://api.anthropic.com',
  CONSOLE_AUTHORIZE_URL: 'https://platform.claude.com/oauth/authorize',
  CLAUDE_AI_AUTHORIZE_URL: 'https://claude.com/cai/oauth/authorize',
  CLAUDE_AI_ORIGIN: 'https://claude.ai',
  TOKEN_URL: 'https://platform.claude.com/v1/oauth/token',
  API_KEY_URL: 'https://api.anthropic.com/api/oauth/claude_cli/create_api_key',
  ROLES_URL: 'https://api.anthropic.com/api/oauth/claude_cli/roles',
  CONSOLE_SUCCESS_URL:
    'https://platform.claude.com/buy_credits?returnUrl=/oauth/code/success%3Fapp%3Dclaude-code',
  CLAUDEAI_SUCCESS_URL: 'https://platform.claude.com/oauth/code/success?app=claude-code',
  MANUAL_REDIRECT_URL: 'https://platform.claude.com/oauth/code/callback',
  CLIENT_ID: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  OAUTH_FILE_SUFFIX: '',
  MCP_PROXY_URL: 'https://mcp-proxy.anthropic.com',
  MCP_PROXY_PATH: '/v1/mcp/{server_id}',
}

export const ANTHROPIC_CLIENT_CONTRACT_VERSION = '2.1.257'

const CLIENT_CONTRACT_VERSION_SHAPE = /^\d+\.\d+\.\d+$/

export type AnthropicClientContract = {
  presented: string
  source: 'constant' | 'override'
  ignoredOverride?: string
}

export function describeAnthropicClientContract(): AnthropicClientContract {
  const raw = process.env.MERCURY_ANTHROPIC_CLIENT_CONTRACT
  const override = raw === undefined ? '' : raw.trim()
  if (override === '') return { presented: ANTHROPIC_CLIENT_CONTRACT_VERSION, source: 'constant' }
  if (!CLIENT_CONTRACT_VERSION_SHAPE.test(override)) {
    return { presented: ANTHROPIC_CLIENT_CONTRACT_VERSION, source: 'constant', ignoredOverride: override }
  }
  return { presented: override, source: 'override' }
}

export function getAnthropicClientContractVersion(): string {
  return describeAnthropicClientContract().presented
}

export const MCP_CLIENT_METADATA_URL = 'https://claude.ai/oauth/claude-code-client-metadata'

export const CONSOLE_OAUTH_SCOPES = ['org:create_api_key', 'user:profile'] as const
export const CLAUDE_AI_OAUTH_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
] as const

export const ALL_OAUTH_SCOPES: string[] = [
  ...new Set<string>([...CONSOLE_OAUTH_SCOPES, ...CLAUDE_AI_OAUTH_SCOPES]),
]

export const CLAUDE_AI_INFERENCE_SCOPE = 'user:inference'
export const CLAUDE_AI_PROFILE_SCOPE = 'user:profile'
export const OAUTH_BETA_HEADER = 'oauth-2025-04-20'

const CUSTOM_OAUTH_ALLOWLIST = [
  'https://beacon.claude-ai.staging.ant.dev',
  'https://claude.fedstart.com',
  'https://claude-staging.fedstart.com',
]

function trimmedCustomUrl(): string | undefined {
  const raw = process.env.MERCURY_CUSTOM_OAUTH_URL
  if (!raw) return undefined
  return raw.endsWith('/') ? raw.slice(0, -1) : raw
}

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

export function getOauthConfig(): OauthConfig {
  const config: OauthConfig = { ...PRODUCTION_CONFIG }
  const custom = trimmedCustomUrl()
  if (custom !== undefined) {
    if (!CUSTOM_OAUTH_ALLOWLIST.includes(custom) && !isLoopbackOauthOrigin(custom)) {
      throw new Error(
        `MERCURY_CUSTOM_OAUTH_URL is set to ${custom}, which is not an approved OAuth endpoint`,
      )
    }
    config.BASE_API_URL = custom
    config.CONSOLE_AUTHORIZE_URL = `${custom}/oauth/authorize`
    config.CLAUDE_AI_AUTHORIZE_URL = `${custom}/oauth/authorize`
    config.CLAUDE_AI_ORIGIN = custom
    config.TOKEN_URL = `${custom}/v1/oauth/token`
    config.API_KEY_URL = `${custom}/api/oauth/claude_cli/create_api_key`
    config.ROLES_URL = `${custom}/api/oauth/claude_cli/roles`
    config.CONSOLE_SUCCESS_URL = `${custom}/oauth/code/success?app=claude-code`
    config.CLAUDEAI_SUCCESS_URL = `${custom}/oauth/code/success?app=claude-code`
    config.MANUAL_REDIRECT_URL = `${custom}/oauth/code/callback`
    config.OAUTH_FILE_SUFFIX = fileSuffixForOauthConfig()
  }
  const clientIdOverride = process.env.MERCURY_OAUTH_CLIENT_ID
  if (clientIdOverride) {
    config.CLIENT_ID = clientIdOverride
  }
  return config
}

export function fileSuffixForOauthConfig(): string {
  const custom = trimmedCustomUrl()
  if (custom === undefined) return ''
  return isLoopbackOauthOrigin(custom) ? '' : '-custom-oauth'
}
