import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { checkHasTrustDialogAccepted } from '../../utils/config.js'
import { getCwd } from '../../utils/cwd.js'
import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { logError, logMCPDebug, logMCPError } from '../../utils/log.js'
import { commandShellOption } from '../../utils/platform/spawn.js'
import type { McpServerConfig, ScopedMcpServerConfig } from '../../utils/mcp/types.js'

const HELPER_TIMEOUT_MS = 10_000

type RemoteWithHelper = {
  url?: string
  headers?: Record<string, string>
  headersHelper?: string
  scope?: string
}

export async function getMcpServerHeaders(
  serverName: string,
  config: McpServerConfig | ScopedMcpServerConfig,
): Promise<Record<string, string>> {
  const record = config as RemoteWithHelper
  const staticHeaders: Record<string, string> = record.headers ? { ...record.headers } : {}
  const helper = record.headersHelper
  if (!helper) {
    return staticHeaders
  }

  if (
    (record.scope === 'project' || record.scope === 'local') &&
    !getIsNonInteractiveSession() &&
    !checkHasTrustDialogAccepted()
  ) {
    const refusal = new Error(
      `headersHelper for MCP server "${serverName}" skipped because workspace trust has not been accepted`,
    )
    logMCPError(serverName, refusal)
    return staticHeaders
  }

  logMCPDebug(serverName, 'Executing headersHelper command')
  const result = await execFileNoThrowWithCwd(helper, [], {
    shell: commandShellOption(),
    timeout: HELPER_TIMEOUT_MS,
    cwd: getCwd(),
    env: {
      ...subprocessEnv(),
      MERCURY_MCP_SERVER_NAME: serverName,
      ...(record.url !== undefined ? { MERCURY_MCP_SERVER_URL: record.url } : {}),
    },
  })

  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.error || ''
    const err = new Error(
      `headersHelper for MCP server "${serverName}" failed with exit code ${result.code}${detail ? `: ${detail}` : ''}`,
    )
    logMCPError(serverName, err)
    logError(err)
    throw err
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout.trim())
  } catch (parseErr) {
    const err = new Error(
      `headersHelper for MCP server "${serverName}" returned invalid JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
    )
    logMCPError(serverName, err)
    throw err
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const err = new Error(
      `headersHelper for MCP server "${serverName}" must output a JSON object of string header values`,
    )
    logMCPError(serverName, err)
    throw err
  }

  const helperHeaders: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      const err = new Error(
        `headersHelper for MCP server "${serverName}" returned a non-string value for header "${key}"`,
      )
      logMCPError(serverName, err)
      throw err
    }
    helperHeaders[key] = value
  }

  logMCPDebug(serverName, `headersHelper returned ${Object.keys(helperHeaders).length} header(s)`)
  return { ...staticHeaders, ...helperHeaders }
}
