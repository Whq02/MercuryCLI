import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { checkHasTrustDialogAccepted } from '../../utils/config.js'
import { getCwd } from '../../utils/cwd.js'
import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { logError, logMCPDebug, logMCPError } from '../../utils/log.js'
import { commandShellOption } from '../../utils/platform/spawn.js'
import type { McpServerConfig, ScopedMcpServerConfig } from '../../utils/mcp/types.js'
import { notBuilt } from '../../pi/holes.js'

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
  return notBuilt('src/services/mcp/headersHelper.ts:88')
}
