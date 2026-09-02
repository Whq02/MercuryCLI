/**
 * The provider-routing variable set (stripped when a host owns routing), the
 * safe pre-trust allowlist, and the settings keys whose values are shell
 * commands. Every spelling here is an external contract.
 */

const MODEL_TIERS = ['HAIKU', 'OPUS', 'SONNET'] as const
const TIER_SUFFIXES = ['_MODEL', '_MODEL_DESCRIPTION', '_MODEL_NAME'] as const

function tierSpellings(): string[] {
  const out: string[] = []
  for (const tier of MODEL_TIERS) {
    for (const suffix of TIER_SUFFIXES) out.push(`ANTHROPIC_DEFAULT_${tier}${suffix}`)
  }
  return out
}

/** Exact spellings a host-managed routing declaration strips from settings-sourced environments. */
const PROVIDER_MANAGED_EXACT: ReadonlySet<string> = new Set(
  [
    // Settings cannot unset the flag once the host set it.
    'MERCURY_PROVIDER_MANAGED_BY_HOST',
    // Endpoint configuration.
    'ANTHROPIC_BASE_URL',
    // Authentication.
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'MERCURY_OAUTH_TOKEN',
    // Model defaults.
    'ANTHROPIC_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
    ...tierSpellings(),
  ].map(name => name.toUpperCase()),
)

/** Case-insensitive exact-set membership. */
export function isProviderManagedEnvVar(key: string): boolean {
  return PROVIDER_MANAGED_EXACT.has(key.toUpperCase())
}

/**
 * The source of truth for which environment variables may be applied before
 * trust (equivalently: which a remote managed-settings payload may set
 * without a security dialog). Anything not here is dangerous by construction:
 * traffic redirection (base URLs, proxies), trusting an attacker's server (TLS
 * rejection disable, extra CA certificates), and identity switching (API
 * keys) are all excluded.
 */
export const SAFE_ENV_VARS: Set<string> = new Set(
  [
    'ANTHROPIC_CUSTOM_HEADERS',
    'ANTHROPIC_CUSTOM_MODEL_OPTION',
    'ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION',
    'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME',
    ...tierSpellings(),
    'ANTHROPIC_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
    'BASH_DEFAULT_TIMEOUT_MS',
    'BASH_MAX_OUTPUT_LENGTH',
    'BASH_MAX_TIMEOUT_MS',
    'MERCURY_API_KEY_HELPER_TTL_MS',
    'MERCURY_MAX_OUTPUT_TOKENS',
    'DISABLE_AUTOUPDATER',
    'DISABLE_BUG_COMMAND',
    'DISABLE_COST_WARNINGS',
    'DISABLE_ERROR_REPORTING',
    'DISABLE_FEEDBACK_COMMAND',
    'DISABLE_TELEMETRY',
    'MERCURY_TOOL_SEARCH',
    'MAX_MCP_OUTPUT_TOKENS',
    'MAX_THINKING_TOKENS',
    'MCP_TIMEOUT',
    'MCP_TOOL_TIMEOUT',
    'MERCURY_IDE_SKIP_AUTO_INSTALL',
    'MERCURY_TERMINAL_TITLE',
    'USE_BUILTIN_RIPGREP',
  ].map(name => name.toUpperCase()),
)

/** Settings keys whose values are shell commands the harness will execute. */
export const DANGEROUS_SHELL_SETTINGS: readonly string[] = [
  'apiKeyHelper',
]
