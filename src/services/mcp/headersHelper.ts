/**
 * Dynamic HTTP headers for remote MCP servers: execute a per-server
 * `headersHelper` command and merge its output over the static headers.
 *
 * Failure semantics are a deliberate Mercury altitude change (seam /
 * XC-7): a CONFIGURED helper that fails must THROW so the server's
 * connection fails carrying the real cause. Connecting anyway, minus the
 * credentials the helper was supposed to supply, produces a server that
 * rejects every call — and a user who spends the afternoon debugging the
 * wrong component. "No dynamic headers" stays reserved exclusively for
 * helper-not-configured and the pre-trust decline.
 */
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { checkHasTrustDialogAccepted } from '../../utils/config.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { logError, logMCPDebug, logMCPError } from '../../utils/log.js'
import type { McpServerConfig, ScopedMcpServerConfig } from './types.js'

const HELPER_TIMEOUT_MS = 10_000

type RemoteWithHelper = {
  url?: string
  headers?: Record<string, string>
  headersHelper?: string
  scope?: string
}

/**
 * Run the configured headers helper, if any.
 *
 * Returns undefined when no helper is configured, or when the pre-trust gate
 * declines. THROWS when a configured helper fails (see the module header).
 */
export async function getMcpHeadersFromHelper(
  serverName: string,
  config: McpServerConfig | ScopedMcpServerConfig,
): Promise<Record<string, string> | undefined> {
  const entry = config as RemoteWithHelper
  const helper = entry.headersHelper
  if (helper === undefined || helper === '') return undefined

  // Pre-trust gate: a project/local helper in an interactive session must not
  // run before the workspace-trust dialog was accepted. The scope check is a
  // dynamic property test — an entry handed in without a scope skips it, and
  // non-interactive sessions (CI/automation) skip it too.
  const scope = entry.scope
  if (
    (scope === 'project' || scope === 'local') &&
    !getIsNonInteractiveSession() &&
    !checkHasTrustDialogAccepted()
  ) {
    logError(
      `MCP server "${serverName}" configures a headersHelper that would have run before workspace trust was confirmed; it was not executed — ${MACRO.ISSUES_EXPLAINER}`,
    )
    return undefined
  }

  logMCPDebug(serverName, `running headersHelper: ${helper}`)
  // The helper COMMAND STRING runs through a shell with no argument list
  // (credential-helper style), in the session working directory, via the
  // non-throwing exec helper.
  const [shellFile, shellArgs] =
    process.platform === 'win32'
      ? ['cmd.exe', ['/c', helper]]
      : ['/bin/sh', ['-c', helper]]
  const result = await execFileNoThrow(shellFile as string, shellArgs as string[], {
    useCwd: true,
    timeout: HELPER_TIMEOUT_MS,
    env: {
      ...subprocessEnv(),
      MERCURY_MCP_SERVER_NAME: serverName,
      MERCURY_MCP_SERVER_URL: entry.url ?? '',
    },
  })

  const fail = (cause: string): never => {
    const message =
      `The headersHelper for MCP server "${serverName}" failed: ${cause}. ` +
      `The connection was not attempted without its auth headers. ` +
      `Fix the helper command or remove the headersHelper setting.`
    logMCPError(serverName, message)
    logError(message)
    throw new Error(message)
  }

  if (result.code !== 0) {
    return fail(`exited with code ${result.code}${result.stderr ? ` (${result.stderr.trim()})` : ''}`)
  }
  const output = result.stdout.trim()
  if (output === '') {
    return fail('produced no output')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch (error) {
    return fail(`output is not valid JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('output must be a JSON object of header names to string values')
  }
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      return fail(`header "${key}" has a non-string value (${typeof value})`)
    }
    headers[key] = value
  }
  logMCPDebug(serverName, `headersHelper produced ${Object.keys(headers).length} header(s)`)
  return headers
}

/**
 * The effective headers for a server: static headers overlaid by dynamic
 * helper headers (dynamic wins on key collision).
 */
export async function getMcpServerHeaders(
  serverName: string,
  config: McpServerConfig | ScopedMcpServerConfig,
): Promise<Record<string, string>> {
  const staticHeaders = (config as RemoteWithHelper).headers ?? {}
  const dynamicHeaders = await getMcpHeadersFromHelper(serverName, config)
  if (dynamicHeaders === undefined) return { ...staticHeaders }
  return { ...staticHeaders, ...dynamicHeaders }
}
