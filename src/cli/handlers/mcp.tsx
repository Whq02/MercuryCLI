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
import { errorMessage, getErrnoCode } from '../../utils/errors.js'
import { gracefulShutdown } from '../../utils/gracefulShutdown.js'
import { safeParseJSONC } from '../../utils/json.js'
import { withDeadline } from '../../utils/deadline.js'
import { passedOver } from '../../utils/passedOver.js'

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
  let cwd: string | undefined
  try {
    cwd = process.cwd()
    await stat(cwd)
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
      const detail = cwd !== undefined ? `${cwd} (${errorMessage(error)})` : errorMessage(error)
      return cliError(`The working directory is not accessible: ${detail}`)
    }
    throw error
  }
  try {
    const { setup } = await import('../../setup.js')
    await setup(cwd, 'default', false, false, undefined, false)
    const { startMCPServer } = await import('../../entrypoints/mcp.js')
    await startMCPServer(cwd, options.debug === true)
  } catch (error) {
    return cliError(`Failed to start the MCP server: ${errorMessage(error)}`)
  }
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
  let targetScope: CliScope
  let targetConfig: ScopedMcpServerConfig | undefined

  if (options.scope !== undefined) {
    targetScope = normalizeScope(options.scope, 'local')
    const scopedServers = getMcpConfigsByScope(targetScope).servers
    targetConfig = Object.hasOwn(scopedServers, name) ? scopedServers[name] : undefined
  } else {
    const holders: Array<{ scope: CliScope; config: ScopedMcpServerConfig }> = []
    const scopeOrder: readonly CliScope[] = ['local', 'project', 'user']
    for (const scope of scopeOrder) {
      const scopedServers = getMcpConfigsByScope(scope).servers
      if (Object.hasOwn(scopedServers, name)) {
        const entry = scopedServers[name]
        if (entry !== undefined) holders.push({ scope, config: entry })
      }
    }
    if (holders.length === 0) {
      return cliError(`No MCP server named ${name} is configured`)
    }
    if (holders.length > 1) {
      const details = holders
        .map(holder => `  - ${holder.scope} (${scopeConfigFileLabel(holder.scope)})`)
        .join('\n')
      const commands = holders
        .map(holder => `  ${binaryName()} mcp remove "${name}" -s ${holder.scope}`)
        .join('\n')
      return cliError(
        `MCP server ${name} exists in multiple scopes:\n${details}\n\nRemove it from a specific scope with:\n${commands}`,
      )
    }
    targetScope = holders[0]!.scope
    targetConfig = holders[0]!.config
  }

  let revoked: Promise<void> | undefined
  const remoteConfig =
    targetConfig !== undefined && (targetConfig.type === 'sse' || targetConfig.type === 'http')
      ? targetConfig
      : undefined
  const beforeRemoval =
    remoteConfig !== undefined
      ? (): void => {
          refuseUnreadTokenStore(name, remoteConfig)
          const pending = revokeServerTokens(name, remoteConfig)
          pending.catch(passedOver)
          clearServerTokensFromLocalStorage(name, remoteConfig)
          clearMcpClientConfig(name, remoteConfig)
          revoked = pending
        }
      : undefined

  try {
    await removeMcpConfig(name, targetScope, beforeRemoval)
  } catch (error) {
    if (revoked !== undefined) {
      await revocationAnswered(name, revoked)
    }
    return cliError(errorMessage(error))
  }

  if (revoked !== undefined) {
    await revocationAnswered(name, revoked)
  }

  return cliOk(
    `Removed MCP server ${name} from ${targetScope} scope\nModified: ${scopeConfigFileLabel(targetScope)}`,
  )
}

function formatServerSummary(config: ScopedMcpServerConfig): string {
  const written = mcpConfigAsWritten(config)
  if (config.type === undefined || config.type === 'stdio') {
    return [written.command ?? config.command, ...written.args].filter(Boolean).join(' ')
  }
  if (config.type === 'http' || config.type === 'sse') {
    return `${describeUrlRedacted(written.url ?? config.url)} (${config.type.toUpperCase()})`
  }
  if (config.type === 'claudeai-proxy') {
    return describeUrlRedacted(written.url ?? config.url)
  }
  const url = written.url
  return url ? `${describeUrlRedacted(url)} (${config.type})` : `(${config.type})`
}

export async function mcpListHandler(): Promise<void> {
  const { servers, errors } = await getMercuryMcpConfigs()
  const configFaults = errors.filter(notice => notice.kind === 'config-fault')
  const boundedNotices = errors.filter(notice => notice.kind === 'document-bounded')
  for (const notice of configFaults) {
    console.error(notice.message)
  }
  for (const notice of boundedNotices) {
    console.log(notice.message)
  }
  const trustLine = mcpServersSkippedForTrustLine()
  if (trustLine !== null) {
    console.log(trustLine)
  }
  const approvalLines = mcpServersSkippedForApprovalLines()
  for (const item of approvalLines) {
    console.log(item.line)
  }

  const entries = Object.entries(servers).sort(([a], [b]) => a.localeCompare(b))
  if (entries.length === 0) {
    if (
      configFaults.length === 0 &&
      boundedNotices.length === 0 &&
      trustLine === null &&
      approvalLines.length === 0
    ) {
      console.log(`No MCP servers configured. Add one with: ${binaryName()} mcp add`)
    }
    await gracefulShutdown(0)
    return
  }

  console.log('Checking MCP server health…\n')
  const results = await pMap(
    entries,
    async ([name, config]) => ({
      name,
      config,
      result: await probeServer(name, config),
    }),
    { concurrency: getMcpServerConnectionBatchSize() },
  )

  for (const { name, config, result } of results) {
    console.log(`${name}: ${formatServerSummary(config)} — ${renderStatus(result)}`)
  }

  await gracefulShutdown(0)
}

export async function mcpGetHandler(name: string): Promise<void> {
  const config = getMcpConfigByName(name)
  if (!config) {
    return cliError(`No MCP server named ${name} is configured`)
  }

  const trustLine = mcpServerSkippedForTrustLine(name, config)
  if (trustLine !== null) {
    console.log(trustLine)
    await gracefulShutdown(0)
    return
  }

  const approvalLine = mcpServerSkippedForApprovalLine(name, config)
  if (approvalLine !== null) {
    console.log(approvalLine)
    await gracefulShutdown(0)
    return
  }

  const result = await probeServer(name, config)
  const written = mcpConfigAsWritten(config)

  const scope = config.scope ?? 'local'
  console.log(`${name}:`)
  console.log(`  Scope: ${scope}`)
  console.log(`  Status: ${renderStatus(result)}`)
  console.log(`  Type: ${config.type ?? 'stdio'}`)

  if (config.type === undefined || config.type === 'stdio') {
    console.log(`  Command: ${written.command ?? config.command}`)
    if (written.args.length > 0) {
      console.log(`  Args: ${written.args.join(' ')}`)
    }
    const envLines = describeEnvRedacted(config.env)
    if (envLines.length > 0) {
      console.log('  Environment:')
      for (const line of envLines) {
        console.log(`    ${line}`)
      }
    }
  } else if (
    config.type === 'http' ||
    config.type === 'sse' ||
    config.type === 'ws' ||
    config.type === 'claudeai-proxy'
  ) {
    console.log(`  URL: ${describeUrlRedacted(written.url ?? config.url)}`)
    if (
      (config.type === 'http' || config.type === 'sse' || config.type === 'ws') &&
      config.headers !== undefined &&
      Object.keys(config.headers).length > 0
    ) {
      console.log(`  Headers: ${describeHeadersRedacted(config.headers)}`)
    }
    if (config.type === 'http' || config.type === 'sse') {
      const oauthBits: string[] = []
      if (config.oauth?.clientId) {
        oauthBits.push('client_id configured')
      }
      const clientConfig = getMcpClientConfig(name, config)
      if (clientConfig?.clientSecret) {
        oauthBits.push('client_secret configured')
      }
      if (oauthBits.length > 0) {
        console.log(`  OAuth: ${oauthBits.join(', ')}`)
      }
      if (config.oauth?.callbackPort !== undefined) {
        console.log(`  Callback Port: ${config.oauth.callbackPort}`)
      }
    }
  }

  if (scope === 'local' || scope === 'project' || scope === 'user') {
    console.log(`\nRemove this server with: ${binaryName()} mcp remove "${name}" -s ${scope}`)
  }

  await gracefulShutdown(0)
}

export async function mcpAddJsonHandler(
  name: string,
  json: string,
  options: { scope?: string; clientSecret?: true },
): Promise<void> {
  const scope = normalizeScope(options.scope, 'local')
  const parsed = safeParseJSONC(json)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return cliError(`Invalid JSON for MCP server ${name}`)
  }

  const validated = McpServerConfigSchema().safeParse(parsed)
  if (!validated.success) {
    return cliError(
      `Invalid MCP server configuration: ${name}: the config does not match the server schema — ${describeMcpConfigIssues(validated.error.issues, parsed)}`,
    )
  }

  const config: McpServerConfig = validated.data
  const hasRemoteClientId =
    (config.type === 'http' || config.type === 'sse') && Boolean(config.oauth?.clientId)
  let clientSecret: string | undefined
  if (options.clientSecret && hasRemoteClientId) {
    try {
      clientSecret = await readClientSecret()
    } catch (error) {
      return cliError(errorMessage(error))
    }
  }

  try {
    await addMcpConfig(name, config, scope)
    if (clientSecret !== undefined) {
      saveMcpClientSecret(name, config, clientSecret)
    }
  } catch (error) {
    return cliError(errorMessage(error))
  }

  return cliOk(
    `Added ${config.type ?? 'stdio'} MCP server ${name} to ${scope} scope\nModified: ${scopeConfigFileLabel(scope)}`,
  )
}

export async function mcpResetChoicesHandler(): Promise<void> {
  const { error } = updateSettingsForSource('localSettings', {
    kit: {
      projectOn: [],
      projectOff: [],
      trustProjectServers: false,
    },
  })
  if (error !== null) {
    return cliError(errorMessage(error))
  }
  return cliOk(
    'All project-scoped MCP server approvals and rejections were reset. You will be asked to approve them again on the next start.',
  )
}
