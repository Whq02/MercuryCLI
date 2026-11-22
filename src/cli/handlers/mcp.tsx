import { stat } from 'node:fs/promises'
import { describeEnvRedacted, describeHeadersRedacted, describeUrlRedacted } from '../../utils/redactHeaders.js'
import pMap from 'p-map'
import { cliError, cliOk } from '../exit.js'
import { GLYPH } from '../../utils/glyphs.js'
import {
  connectToServer,
  getMcpServerConnectionBatchSize,
} from '../../services/mcp/client.js'
import {
  addMcpConfig,
  getMcpConfigByName,
  getMcpConfigsByScope,
  getMercuryMcpConfigs,
  mcpServerSkippedForApprovalLine,
  mcpServerSkippedForTrustLine,
  mcpServersSkippedForApprovalLines,
  mcpServersSkippedForTrustLine,
  removeMcpConfig,
} from '../../services/mcp/config.js'
import { isMcpCatalogueMember } from '../../services/mcp/membership.js'
import { clipToWord, describeMcpConfigIssues, mcpConfigAsWritten } from '../../services/mcp/utils.js'
import {
  clearMcpClientConfig,
  clearServerTokensFromLocalStorage,
  getMcpClientConfig,
  readClientSecret,
  refuseUnreadTokenStore,
  saveMcpClientSecret,
  revokeServerTokens,
} from '../../services/mcp/auth.js'
import type {
  McpServerConfig,
  ScopedMcpServerConfig,
} from '../../utils/mcp/types.js'
import { McpServerConfigSchema } from '../../utils/mcp/types.js'
import { binaryName } from '../../utils/config.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'
import { errorMessage } from '../../utils/errors.js'
import { gracefulShutdown } from '../../utils/gracefulShutdown.js'
import { safeParseJSONC } from '../../utils/json.js'
import { withDeadline } from '../../utils/deadline.js'
import { notBuilt } from '../../pi/holes.js'

type ProbeOutcome =
  | 'connected'
  | 'needs-authentication'
  | 'disabled'
  | 'failed-to-connect'
  | 'connection-error'

type ProbeResult = { outcome: ProbeOutcome; reason?: string }

export async function probeServer(
  name: string,
  config: ScopedMcpServerConfig,
): Promise<ProbeResult> {
  if (!isMcpCatalogueMember(name)) return { outcome: 'disabled' }
  try {
    const client = await connectToServer(name, config)
    if (client.type === 'connected') return { outcome: 'connected' }
    if (client.type === 'needs-auth') return { outcome: 'needs-authentication' }
    return {
      outcome: 'failed-to-connect',
      ...(client.type === 'failed' && typeof client.error === 'string' && client.error.length > 0
        ? { reason: client.error }
        : {}),
    }
  } catch (err) {
    return { outcome: 'connection-error', reason: errorMessage(err) }
  }
}

function renderStatus(result: ProbeResult): string {
  const reason = result.reason !== undefined && result.reason.length > 0 ? ` — ${clipToWord(result.reason, 160)}` : ''
  switch (result.outcome) {
    case 'connected':
      return `${GLYPH.ok} connected`
    case 'needs-authentication':
      return '- needs authentication'
    case 'disabled':
      return '- disabled (enable from /mcp)'
    case 'failed-to-connect':
      return `${GLYPH.fail} failed to connect${reason}`
    case 'connection-error':
      return `${GLYPH.fail} connection error${reason}`
  }
}

const VALID_SCOPES = ['local', 'user', 'project'] as const
type CliScope = (typeof VALID_SCOPES)[number]

function normalizeScope(scope: string | undefined, fallback: CliScope): CliScope {
  if (scope === undefined) return fallback
  if ((VALID_SCOPES as readonly string[]).includes(scope)) return scope as CliScope
  return cliError(`Invalid scope '${scope}'. Valid scopes: ${VALID_SCOPES.join(', ')}`)
}

function scopeConfigFileLabel(scope: CliScope): string {
  switch (scope) {
    case 'local':
      return 'the local project config'
    case 'project':
      return "the project's .mercury/mcp.json"
    case 'user':
      return 'the user config'
  }
}


export async function mcpServeHandler(options: {
  debug?: boolean
}): Promise<void> {
  return notBuilt('src/cli/handlers/mcp.tsx:110')
}


const MCP_REVOKE_WAIT_MS = 10_000

async function revocationAnswered(name: string, revoked: Promise<void>): Promise<void> {
  const late = await withDeadline(revoked.then(() => false), MCP_REVOKE_WAIT_MS, () => true)
  if (late) console.error(`The authorization server of ${name} did not answer within ${MCP_REVOKE_WAIT_MS / 1000} s, so its tokens may stay valid there until they expire; the local copies are cleared.`)
}

export async function mcpRemoveHandler(
  name: string,
  options: { scope?: string },
): Promise<void> {
  return notBuilt('src/cli/handlers/mcp.tsx:143')
}


export async function mcpListHandler(): Promise<void> {
  return notBuilt('src/cli/handlers/mcp.tsx:207')
}


export async function mcpGetHandler(name: string): Promise<void> {
  return notBuilt('src/cli/handlers/mcp.tsx:253')
}


export async function mcpAddJsonHandler(
  name: string,
  json: string,
  options: { scope?: string; clientSecret?: true },
): Promise<void> {
  return notBuilt('src/cli/handlers/mcp.tsx:314')
}


export async function mcpResetChoicesHandler(): Promise<void> {
  return notBuilt('src/cli/handlers/mcp.tsx:351')
}
