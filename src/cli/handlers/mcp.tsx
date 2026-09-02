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
    const { setup } = await import('../../setup.js')
    await setup(cwd, 'default', false, false, undefined, false)
    const { startMCPServer } = await import('../../entrypoints/mcp.js')
    await startMCPServer(cwd, options.debug ?? false, options.verbose ?? false)
  } catch (error) {
    return cliError(
      `Failed to start the MCP server: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}


export async function mcpRemoveHandler(
  name: string,
  options: { scope?: string },
): Promise<void> {
  try {
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
    const holders: CliScope[] = []
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
      const target = typeof (config as { url?: unknown }).url === 'string' ? ` ${(config as { url: string }).url}` : ''
      process.stdout.write(`${name}:${target} (${String(config.type)}) — ${status}\n`)
    }
  })
  await gracefulShutdown(0)
}


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
      process.stdout.write('  Headers:\n')
      for (const line of describeHeadersRedacted(config.headers).split(', ')) {
        process.stdout.write(`    ${line}\n`)
      }
    }
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
    const validated = McpServerConfigSchema().safeParse(parsed)
    let clientSecret: string | undefined
    if (
      options.clientSecret &&
      validated.success &&
      (validated.data.type === 'sse' || validated.data.type === 'http') &&
      validated.data.oauth?.clientId
    ) {
      clientSecret = await readClientSecret()
    }
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
