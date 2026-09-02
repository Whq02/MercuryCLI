/**
 * The single source of OAuth/endpoint configuration: scopes, client id,
 * authorize/token/API URLs, the MCP proxy, and the FedStart custom-URL
 * override with its allowlist. Callers never build these URLs themselves.
 *
 * Only the production environment exists in this build; the staging/local
 * records are dead and deliberately not reimplemented.
 */

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

// Production values — contract data, byte-exact.
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

/**
 * The client-contract version presented on the first-party subscription
 * door. On that door Mercury already presents the vendor CLI's app identity
 * end to end — CLIENT_ID and the scopes here, `x-app: cli` and the session
 * header in services/api/client.ts, the coding beta in constants/betas.ts —
 * so the subscription endpoint classes the request as that CLI and gates
 * models on a minimum client version. It never checks the name, only the
 * number, and it reads the number from the cc_version field of the billing
 * attribution line (constants/system.ts getAttributionHeader — the
 * system-prompt block the endpoint parses for client attribution), never
 * from the User-Agent: a request whose number sits below a model's floor
 * is refused (HTTP 400, error_code claude_code_version_too_old), and
 * Mercury's own release number sits below every such floor, so presenting
 * it there would lose those models. The rule: present a compatible
 * client-contract version on that one door, and nowhere else — the
 * User-Agent stays `mercury/<version>` on every wire. The constant is the
 * vendor CLI's release number that satisfies the current floors; raise it
 * when a floor moves past it (MERCURY_ANTHROPIC_CLIENT_CONTRACT overrides
 * it until then). Contract data — it is not Mercury's version and rides
 * nothing else.
 */
export const ANTHROPIC_CLIENT_CONTRACT_VERSION = '2.1.257'

/** A three-part version string — the only shape the door presents. */
const CLIENT_CONTRACT_VERSION_SHAPE = /^\d+\.\d+\.\d+$/

export type AnthropicClientContract = {
  /** The version the door presents right now. */
  presented: string
  /** Where it came from. */
  source: 'constant' | 'override'
  /** An override that was set but ignored (not a three-part version). */
  ignoredOverride?: string
}

/**
 * The client-contract version the door presents right now, with its source:
 * the operator's MERCURY_ANTHROPIC_CLIENT_CONTRACT (a three-part version
 * string — the endpoint's floor moves without a rebuild) wins over the
 * constant; any other shape is ignored and reported, never presented. Read
 * live on every call so an env change takes effect on the next request.
 */
export function describeAnthropicClientContract(): AnthropicClientContract {
  const raw = process.env.MERCURY_ANTHROPIC_CLIENT_CONTRACT
  const override = raw === undefined ? '' : raw.trim()
  if (override === '') return { presented: ANTHROPIC_CLIENT_CONTRACT_VERSION, source: 'constant' }
  if (!CLIENT_CONTRACT_VERSION_SHAPE.test(override)) {
    return { presented: ANTHROPIC_CLIENT_CONTRACT_VERSION, source: 'constant', ignoredOverride: override }
  }
  return { presented: override, source: 'override' }
}

/** The version the door presents right now (override over constant). */
export function getAnthropicClientContractVersion(): string {
  return describeAnthropicClientContract().presented
}

/**
 * The CIMD (SEP-991) client-id metadata document URL: used AS the client_id
 * when an MCP authorization server advertises
 * `client_id_metadata_document_supported: true`, replacing Dynamic Client
 * Registration. Contract data.
 */
export const MCP_CLIENT_METADATA_URL = 'https://claude.ai/oauth/claude-code-client-metadata'

// Scopes — contract data; the authorization server matches them literally.
export const CONSOLE_OAUTH_SCOPES = ['org:create_api_key', 'user:profile'] as const
export const CLAUDE_AI_OAUTH_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
] as const

/**
 * The de-duplicated union, console scopes FIRST: login requests everything
 * so a Console→subscriber redirect still holds every needed scope.
 */
export const ALL_OAUTH_SCOPES: string[] = [
  ...new Set<string>([...CONSOLE_OAUTH_SCOPES, ...CLAUDE_AI_OAUTH_SCOPES]),
]

export const CLAUDE_AI_INFERENCE_SCOPE = 'user:inference'
export const CLAUDE_AI_PROFILE_SCOPE = 'user:profile'
export const OAUTH_BETA_HEADER = 'oauth-2025-04-20'

/**
 * The FedStart/PubSec endpoint allowlist — a security contract with exactly
 * three fixed entries; it prevents OAuth tokens being sent to an arbitrary
 * host.
 */
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

/**
 * Resolve the endpoint record. Built fresh on each call so an env change
 * mid-process takes effect on the next read. THROWS on a custom OAuth URL
 * outside the allowlist — on every read, so any caller can see it.
 */
export function getOauthConfig(): OauthConfig {
  const config: OauthConfig = { ...PRODUCTION_CONFIG }
  const custom = trimmedCustomUrl()
  if (custom !== undefined) {
    if (!CUSTOM_OAUTH_ALLOWLIST.includes(custom)) {
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
    config.OAUTH_FILE_SUFFIX = '-custom-oauth'
    // The MCP proxy fields and CLIENT_ID are deliberately NOT rewritten.
  }
  const clientIdOverride = process.env.MERCURY_OAUTH_CLIENT_ID
  if (clientIdOverride) {
    config.CLIENT_ID = clientIdOverride
  }
  return config
}

/**
 * The credential-file suffix, so different environments never collide.
 * Checked BEFORE and independently of the allowlist — this accessor never
 * throws on a disallowed URL, it just reports the custom suffix.
 */
export function fileSuffixForOauthConfig(): string {
  return process.env.MERCURY_CUSTOM_OAUTH_URL ? '-custom-oauth' : ''
}
