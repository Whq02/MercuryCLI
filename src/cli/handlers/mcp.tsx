// ============================================================================
//  src/cli/handlers/mcp.tsx — the `mercury mcp …` subcommand bodies:
//  serve, remove, list, get, add-json, reset-project-choices. The MCP verbs
//  speak the design-system glyph table (distinct from the extensions verbs'
//  terminal-figures marks).
// ============================================================================
import { stat } from 'node:fs/promises'
import { describeHeadersRedacted } from '../../utils/redactHeaders.js'
import pMap from 'p-map'
import { cliError, cliOk } from '../exit.js'
import { GLYPH } from '../../components/mercury-ui/glyphs.js'
import {
  connectToServer,
  getMcpServerConnectionBatchSize,
} from '../../services/mcp/client.js'
import {
  addMcpConfig,
  getMcpConfigByName,
  getMcpConfigsByScope,
  getMercuryMcpConfigs,
  removeMcpConfig,
} from '../../services/mcp/config.js'
import { isMcpCatalogueMember } from '../../services/mcp/membership.js'
import {
  clearMcpClientConfig,
  clearServerTokensFromLocalStorage,
  getMcpClientConfig,
  readClientSecret,
  saveMcpClientSecret,
  revokeServerTokens,
} from '../../services/mcp/auth.js'
import type {
  McpServerConfig,
  ScopedMcpServerConfig,
} from '../../services/mcp/types.js'
import { McpServerConfigSchema } from '../../services/mcp/types.js'
import { binaryName, getCurrentProjectConfig, saveCurrentProjectConfig } from '../../utils/config.js'
import { errorMessage } from '../../utils/errors.js'
import { gracefulShutdown } from '../../utils/gracefulShutdown.js'
import { safeParseJSONC } from '../../utils/json.js'

type ProbeOutcome =
  | 'connected'
  | 'needs-authentication'
  | 'disabled'
  | 'failed-to-connect'
  | 'connection-error'

/** A probe answers the outcome AND the client's own reason where one failed
 *  (field w4-f05-03): the bare catch printed one reasonless 'connection
 *  error' for every stdio failure, so `mcp list`/`get` could not say WHY. */
type ProbeResult = { outcome: ProbeOutcome; reason?: string }

/** The shared health probe: connect and map the outcome. A server the
 *  operator disabled is REPORTED as disabled, never probed — probing spawns
 *  it (children and all) against the operator's stated wish, and it read
 *  "connected" with no hint of the disable (field F-3.1). Exported as the
 *  proof seam for that law. */
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
  // The reason rides the line, clipped — one row per server stays one row.
  const reason = result.reason !== undefined && result.reason.length > 0 ? ` — ${result.reason.slice(0, 160)}` : ''
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
      return '.mcp.json'
    case 'user':
      return 'the user config'
  }
}

// ── serve ──────────────────────────────────────────────────────────────────

export async function mcpServeHandler(options: {
  debug?: boolean
  verbose?: boolean
}): Promise<void> {
  const cwd = process.cwd()
  try {
    await stat(cwd)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
      return cliError(`The working directory is not accessible: ${cwd}`)
    }
    throw error
  }
  try {
    // Lazy imports keep the subcommand's startup cost off the general path.
    const { setup } = await import('../../setup.js')
    await setup(cwd, 'default', false, false, undefined, false)
    const { startMCPServer } = await import('../../entrypoints/mcp.js')
    await startMCPServer(cwd, options.debug ?? false, options.verbose ?? false)
    // On success the server runs until the process ends.
  } catch (error) {
    return cliError(
      `Failed to start the MCP server: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

// ── remove ─────────────────────────────────────────────────────────────────

export async function mcpRemoveHandler(
  name: string,
  options: { scope?: string },
): Promise<void> {
  try {
    // Look the config up BEFORE removing so secure storage can be cleaned.
    const existing = getMcpConfigByName(name)
    const cleanSecureStorage = (config: McpServerConfig | null): void => {
      if (!config) return
      if (config.type === 'sse' || config.type === 'http') {
        void revokeServerTokens(name, config).catch(() => {})
        clearServerTokensFromLocalStorage(name, config)
        clearMcpClientConfig(name, config)
      }
    }
    if (options.scope !== undefined) {
      const scope = normalizeScope(options.scope, 'local')
      await removeMcpConfig(name, scope)
      cleanSecureStorage(existing as McpServerConfig | null)
      process.stdout.write(`Removed MCP server ${name} from ${scope} scope\n`)
      return cliOk(`Modified: ${scopeConfigFileLabel(scope)}`)
    }
    // No scope: find which scopes hold the server, in local → project →
    // user order.
    const holders: CliScope[] = []
    // Membership tests the SERVERS MAP, never the {servers, errors} wrapper
    // (FC-035): the wrapper keys made every real server "not configured"
    // while the literal names servers/errors reported existing in all three
    // scopes.
    const local = getMcpConfigsByScope('local')
    const project = getMcpConfigsByScope('project')
    const user = getMcpConfigsByScope('user')
    if (name in local.servers) holders.push('local')
    if (name in project.servers) holders.push('project')
    if (name in user.servers) holders.push('user')
    if (holders.length === 0) {
      return cliError(`No MCP server named ${name} is configured`)
    }
    if (holders.length === 1) {
      const scope = holders[0]!
      await removeMcpConfig(name, scope)
      cleanSecureStorage(existing as McpServerConfig | null)
      process.stdout.write(`Removed MCP server ${name} from ${scope} scope\n`)
      return cliOk(`Modified: ${scopeConfigFileLabel(scope)}`)
    }
    // Multiple scopes: explain on stderr with per-scope removal commands and
    // remove nothing.
    console.error(`MCP server ${name} exists in multiple scopes:`)
    for (const scope of holders) {
      console.error(`  ${scope} (${scopeConfigFileLabel(scope)})`)
    }
    console.error('Remove it from a specific scope with:')
    for (const scope of holders) {
      console.error(`  ${binaryName()} mcp remove ${name} --scope ${scope}`)
    }
    return cliError()
  } catch (error) {
    return cliError(error instanceof Error ? error.message : String(error))
  }
}

// ── list ───────────────────────────────────────────────────────────────────

export async function mcpListHandler(): Promise<void> {
  const { servers: configs } = await getMercuryMcpConfigs()
  const names = Object.keys(configs)
  if (names.length === 0) {
    process.stdout.write(
      `No MCP servers configured. Add one with: ${binaryName()} mcp add\n`,
    )
    await gracefulShutdown(0)
    return
  }
  process.stdout.write('Checking MCP server health…\n')
  const outcomes = await pMap(
    names,
    async name => probeServer(name, configs[name] as ScopedMcpServerConfig),
    { concurrency: getMcpServerConnectionBatchSize() },
  )
  names.forEach((name, index) => {
    const config = configs[name] as {
      type?: string
      url?: string
      command?: string
      args?: unknown
    }
    const status = renderStatus(outcomes[index]!)
    if (config.type === 'sse' || config.type === 'http') {
      process.stdout.write(`${name}: ${config.url} (${config.type.toUpperCase()}) — ${status}\n`)
    } else if (config.type === 'claudeai-proxy') {
      process.stdout.write(`${name}: ${config.url} — ${status}\n`)
    } else if (config.type === 'stdio' || config.type === undefined) {
      const args = Array.isArray(config.args) ? (config.args as string[]).join(' ') : ''
      process.stdout.write(`${name}: ${config.command ?? ''} ${args} — ${status}\n`)
    } else {
      // The FALLBACK arm (FC-067): a configured, probed server must never
      // be absent from the product's own inventory — a `ws` server printed
      // no line at all.
      const target = typeof (config as { url?: unknown }).url === 'string' ? ` ${(config as { url: string }).url}` : ''
      process.stdout.write(`${name}:${target} (${String(config.type)}) — ${status}\n`)
    }
  })
  // The probes started stdio child processes; only the registered cleanup
  // handlers stop them, so termination must be a graceful shutdown.
  await gracefulShutdown(0)
}

// ── get ────────────────────────────────────────────────────────────────────

export async function mcpGetHandler(name: string): Promise<void> {
  const config = getMcpConfigByName(name)
  if (!config) {
    return cliError(`No MCP server named ${name} is configured`)
  }
  const outcome = await probeServer(name, config)
  process.stdout.write(`${name}:\n`)
  process.stdout.write(`  Scope: ${config.scope ?? 'local'}\n`)
  process.stdout.write(`  Status: ${renderStatus(outcome)}\n`)
  if (config.type === 'sse' || config.type === 'http') {
    process.stdout.write(`  Type: ${config.type}\n`)
    process.stdout.write(`  URL: ${config.url}\n`)
    if (config.headers && Object.keys(config.headers).length > 0) {
      // Names ride, credential values mask (the one redaction owner —
      // spelling a headers object onto ANY surface must never ship
      // credential bytes; this loop printed Authorization values in full).
      process.stdout.write('  Headers:\n')
      for (const line of describeHeadersRedacted(config.headers).split(', ')) {
        process.stdout.write(`    ${line}\n`)
      }
    }
    // No OAuth line at all unless a client id or a callback port is set;
    // the stored-secret probe only runs when a client id exists.
    if (config.oauth?.clientId || config.oauth?.callbackPort !== undefined) {
      const summary: string[] = []
      if (config.oauth.clientId) {
        summary.push('client_id configured')
        const hasSecret = Boolean(getMcpClientConfig(name, config)?.clientSecret)
        if (hasSecret) summary.push('client_secret configured')
      }
      if (config.oauth.callbackPort !== undefined) {
        summary.push(`callback port ${config.oauth.callbackPort}`)
      }
      process.stdout.write(`  OAuth: ${summary.join(', ')}\n`)
    }
  } else if (config.type === 'stdio' || config.type === undefined) {
    // UNTYPED = stdio by the schema's own default (FC-067): the explicit
    // check left the default shape with no Type/Command/Args at all.
    process.stdout.write('  Type: stdio\n')
    process.stdout.write(`  Command: ${config.command ?? ''}\n`)
    const args = Array.isArray(config.args) ? config.args.join(' ') : ''
    process.stdout.write(`  Args: ${args}\n`)
    if (config.env && Object.keys(config.env).length > 0) {
      process.stdout.write('  Environment:\n')
      for (const [key, value] of Object.entries(config.env)) {
        process.stdout.write(`    ${key}=${value}\n`)
      }
    }
  } else {
    // The FALLBACK arm (FC-067): any other transport still names its type
    // and target instead of omitting the section.
    process.stdout.write(`  Type: ${String(config.type)}\n`)
    if (typeof (config as { url?: unknown }).url === 'string') {
      process.stdout.write(`  URL: ${(config as { url: string }).url}\n`)
    }
  }
  process.stdout.write('\n')
  process.stdout.write(
    `Remove this server with: ${binaryName()} mcp remove ${name} --scope ${config.scope ?? 'local'}\n`,
  )
  await gracefulShutdown(0)
}

// ── add-json ───────────────────────────────────────────────────────────────

export async function mcpAddJsonHandler(
  name: string,
  json: string,
  options: { scope?: string; clientSecret?: true },
): Promise<void> {
  try {
    const scope = normalizeScope(options.scope, 'local')
    const parsed = safeParseJSONC(json)
    if (!parsed || typeof parsed !== 'object') {
      return cliError(`Invalid JSON for MCP server ${name}`)
    }
    // The schema validation both narrows the shape and is what addMcpConfig
    // enforces anyway; validating first keeps the secret probe honest.
    const validated = McpServerConfigSchema().safeParse(parsed)
    // The secret prompt is the step a user may abandon; abandoning it must
    // not leave a half-added server, so read it BEFORE writing the config.
    let clientSecret: string | undefined
    if (
      options.clientSecret &&
      validated.success &&
      (validated.data.type === 'sse' || validated.data.type === 'http') &&
      validated.data.oauth?.clientId
    ) {
      clientSecret = await readClientSecret()
    }
    // The write gates on the schema (this used to compute validation and
    // persist the RAW object regardless — an invalid config landed on disk
    // with a success receipt).
    if (!validated.success) {
      cliError(`mcp add-json ${name}: the config does not match the server schema — ${validated.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join(' · ')}`)
      return
    }
    await addMcpConfig(name, parsed, scope)
    const transport = validated.success ? (validated.data.type ?? 'stdio') : 'stdio'
    if (clientSecret !== undefined && validated.success) {
      saveMcpClientSecret(name, validated.data, clientSecret)
    }
    return cliOk(`Added ${transport} MCP server ${name} to ${scope} scope`)
  } catch (error) {
    return cliError(error instanceof Error ? error.message : String(error))
  }
}

// ── reset-project-choices ──────────────────────────────────────────────────

export async function mcpResetChoicesHandler(): Promise<void> {
  saveCurrentProjectConfig(current => ({
    ...current,
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    enableAllProjectMcpServers: false,
  }))
  void getCurrentProjectConfig
  return cliOk(
    'All project-scoped MCP server approvals and rejections were reset. You will be asked to approve them again on the next start.',
  )
}
