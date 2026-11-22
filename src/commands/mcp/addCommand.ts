import { type Command as CommanderCommand } from 'commander'
import { cliError, cliOk } from '../../cli/exit.js'
import { addMcpConfig } from '../../services/mcp/config.js'
import { readClientSecret, saveMcpClientSecret } from '../../services/mcp/auth.js'
import type { McpServerConfig } from '../../utils/mcp/types.js'
import {
  describeMcpConfigFilePath,
  ensureConfigScope,
  ensureTransport,
  parseHeaders,
} from '../../services/mcp/utils.js'
import { binaryName } from '../../utils/config/derived.js'
import { describeHeadersRedacted, describeUrlRedacted } from '../../utils/redactHeaders.js'
import { notBuilt } from '../../pi/holes.js'

function parseEnvAssignments(pairs: string[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const pair of pairs) {
    const eq = pair.indexOf('=')
    if (eq <= 0) {
      throw new Error(`Invalid environment variable "${pair}" — expected KEY=VALUE`)
    }
    env[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return env
}

export function registerMcpAddCommand(mcp: CommanderCommand): void {
  return notBuilt('src/commands/mcp/addCommand.ts:37')
}
