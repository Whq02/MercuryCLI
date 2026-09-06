
const MODEL_TIERS = ['HAIKU', 'OPUS', 'SONNET'] as const
const TIER_SUFFIXES = ['_MODEL', '_MODEL_DESCRIPTION', '_MODEL_NAME'] as const

function tierSpellings(): string[] {
  const out: string[] = []
  for (const tier of MODEL_TIERS) {
    for (const suffix of TIER_SUFFIXES) out.push(`ANTHROPIC_DEFAULT_${tier}${suffix}`)
  }
  return out
}

const PROVIDER_MANAGED_EXACT: ReadonlySet<string> = new Set(
  [
    'MERCURY_PROVIDER_MANAGED_BY_HOST',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'MERCURY_OAUTH_TOKEN',
    'MERCURY_MODEL',
    'MERCURY_SMALL_FAST_MODEL',
    ...tierSpellings(),
  ].map(name => name.toUpperCase()),
)

export function isProviderManagedEnvVar(key: string): boolean {
  return PROVIDER_MANAGED_EXACT.has(key.toUpperCase())
}

export const SAFE_ENV_VARS: Set<string> = new Set(
  [
    'MERCURY_PROVIDER_HEADERS',
    'MERCURY_CUSTOM_MODEL_OPTION',
    'MERCURY_CUSTOM_MODEL_OPTION_DESCRIPTION',
    'MERCURY_CUSTOM_MODEL_OPTION_NAME',
    ...tierSpellings(),
    'MERCURY_MODEL',
    'MERCURY_SMALL_FAST_MODEL',
    'BASH_DEFAULT_TIMEOUT_MS',
    'BASH_MAX_OUTPUT_LENGTH',
    'BASH_MAX_TIMEOUT_MS',
    'MERCURY_API_KEY_HELPER_TTL_MS',
    'MERCURY_MAX_OUTPUT_TOKENS',
    'MERCURY_AUTOUPDATE',
    'MERCURY_BUG_COMMAND',
    'MERCURY_COST_WARNINGS',
    'MERCURY_ERROR_REPORTING',
    'MERCURY_FEEDBACK_COMMAND',
    'MERCURY_TELEMETRY',
    'MERCURY_TOOL_SEARCH',
    'MERCURY_MCP_OUTPUT_TOKENS',
    'MERCURY_THINKING_BUDGET',
    'MERCURY_MCP_TIMEOUT_MS',
    'MERCURY_MCP_TOOL_TIMEOUT_MS',
    'MERCURY_IDE_SKIP_AUTO_INSTALL',
    'MERCURY_TERMINAL_TITLE',
    'MERCURY_BUILTIN_RIPGREP',
  ].map(name => name.toUpperCase()),
)

export const DANGEROUS_SHELL_SETTINGS: readonly string[] = [
  'apiKeyHelper',
]
