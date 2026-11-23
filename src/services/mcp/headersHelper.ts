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

type HelperVerdict = { ok: true; headers: Record<string, string> } | { ok: false; cause: string }

function judgeHelperRun(run: { code: number; stdout: string; stderr: string }): HelperVerdict {
  if (run.code !== 0) {
    return { ok: false, cause: `exited with code ${run.code}${run.stderr !== '' ? ` (${run.stderr.trim()})` : ''}` }
  }
  const output = run.stdout.trim()
  if (output === '') return { ok: false, cause: 'produced no output' }
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch (error) {
    return { ok: false, cause: `output is not valid JSON (${error instanceof Error ? error.message : String(error)})` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, cause: 'output must be a JSON object of header names to string values' }
  }
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      return { ok: false, cause: `header "${key}" has a non-string value (${typeof value})` }
    }
    headers[key] = value
  }
  return { ok: true, headers }
}

async function getMcpHeadersFromHelper(
  serverName: string,
  config: RemoteWithHelper,
): Promise<Record<string, string> | undefined> {
  const command = config.headersHelper
  if (command === undefined || command === '') return undefined
  if (
    (config.scope === 'project' || config.scope === 'local') &&
    !getIsNonInteractiveSession() &&
    !checkHasTrustDialogAccepted()
  ) {
    logError(
      `MCP server "${serverName}" configures a headersHelper that would have run before workspace trust was confirmed; it was not executed — ${MACRO.ISSUES_EXPLAINER}`,
    )
    return undefined
  }
  logMCPDebug(serverName, `running headersHelper: ${command}`)
  const run = await execFileNoThrowWithCwd(command, [], {
    cwd: getCwd(),
    shell: commandShellOption(),
    timeout: HELPER_TIMEOUT_MS,
    env: {
      ...subprocessEnv(),
      MERCURY_MCP_SERVER_NAME: serverName,
      MERCURY_MCP_SERVER_URL: config.url ?? '',
    },
  })
  const verdict = judgeHelperRun(run)
  if (!verdict.ok) {
    const message = `The headersHelper for MCP server "${serverName}" failed: ${verdict.cause}. The connection was not attempted without its auth headers. Fix the helper command or remove the headersHelper setting.`
    logMCPError(serverName, message)
    logError(message)
    throw new Error(message)
  }
  logMCPDebug(serverName, `headersHelper produced ${Object.keys(verdict.headers).length} header(s)`)
  return verdict.headers
}

export async function getMcpServerHeaders(
  serverName: string,
  config: McpServerConfig | ScopedMcpServerConfig,
): Promise<Record<string, string>> {
  const remote = config as RemoteWithHelper
  const dynamicHeaders = await getMcpHeadersFromHelper(serverName, remote)
  return { ...remote.headers, ...dynamicHeaders }
}
