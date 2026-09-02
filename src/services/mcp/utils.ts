import { createHash } from 'node:crypto'

import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { checkHasTrustDialogAccepted } from '../../utils/config.js'
import { getProjectPathForConfig } from '../../utils/config.js'
import { getCwd } from '../../utils/cwd.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { getGlobalMercuryFile } from '../../utils/env.js'
import { errorMessage, errorMessageWithCause, getErrnoCode } from '../../utils/errors.js'
import { isSettingSourceEnabled } from '../../utils/settings/constants.js'
import { getInitialSettings, getSettingsForSource } from '../../utils/settings/settings.js'
import { getEnterpriseMcpFilePath, getMcpConfigByName } from './config.js'
import { getMcpPrefix, mcpInfoFromString } from './mcpStringUtils.js'
import { normalizeNameForMCP } from './normalization.js'
import type {
  ConfigScope,
  McpServerConfig,
  MCPServerConnection,
  ScopedMcpServerConfig,
  ServerResource,
  Transport,
} from './types.js'


type NamedTool = { name: string; mcpInfo?: { serverName?: string } }
type NamedCommand = { name: string; type?: string; source?: string; isMcp?: boolean }

function toolBelongsToServer(tool: NamedTool, serverName: string, prefix: string): boolean {
  if (tool.mcpInfo?.serverName !== undefined) return tool.mcpInfo.serverName === serverName
  return tool.name.startsWith(prefix)
}

export function filterToolsByServer<T extends NamedTool>(tools: T[], serverName: string): T[] {
  const prefix = getMcpPrefix(serverName)
  return tools.filter(tool => toolBelongsToServer(tool, serverName, prefix))
}

export function excludeToolsByServer<T extends NamedTool>(tools: T[], serverName: string): T[] {
  const prefix = getMcpPrefix(serverName)
  return tools.filter(tool => !toolBelongsToServer(tool, serverName, prefix))
}

export function commandBelongsToServer(command: NamedCommand, serverName: string): boolean {
  const normalized = normalizeNameForMCP(serverName)
  return (
    command.name.startsWith(getMcpPrefix(serverName)) ||
    command.name.startsWith(`${normalized}:`)
  )
}

export function filterCommandsByServer<T extends NamedCommand>(
  commands: T[],
  serverName: string,
): T[] {
  return commands.filter(command => commandBelongsToServer(command, serverName))
}

export function excludeCommandsByServer<T extends NamedCommand>(
  commands: T[],
  serverName: string,
): T[] {
  return commands.filter(command => !commandBelongsToServer(command, serverName))
}

export function filterMcpPromptsByServer<T extends NamedCommand>(
  commands: T[],
  serverName: string,
): T[] {
  const prefix = getMcpPrefix(serverName)
  return commands.filter(command => {
    if (!command.name.startsWith(prefix)) return false
    if (command.type === 'prompt' && command.source === 'mcp' && command.isMcp !== true) {
      return false
    }
    return true
  })
}

export function filterResourcesByServer(
  resources: ServerResource[],
  serverName: string,
): ServerResource[] {
  return resources.filter(resource => resource.server === serverName)
}

export function excludeResourcesByServer(
  resources: Record<string, ServerResource[]>,
  serverName: string,
): Record<string, ServerResource[]> {
  const { [serverName]: _removed, ...rest } = resources
  return rest
}

export function isToolFromMcpServer(toolName: string, serverName: string): boolean {
  const info = mcpInfoFromString(toolName)
  return info !== null && info.serverName === normalizeNameForMCP(serverName)
}

export function isMcpTool(tool: { name: string; isMcp?: boolean }): boolean {
  return tool.name.startsWith('mcp__') || tool.isMcp === true
}

export function isMcpCommand(command: { name: string; isMcp?: boolean }): boolean {
  return command.name.startsWith('mcp__') || command.isMcp === true
}


function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )
    const sorted: Record<string, unknown> = {}
    for (const [key, entryValue] of entries) sorted[key] = sortKeysDeep(entryValue)
    return sorted
  }
  return value
}

export function hashMcpConfig(config: McpServerConfig | ScopedMcpServerConfig): string {
  const { scope: _scope, ...content } = config as ScopedMcpServerConfig
  const canonical = JSON.stringify(sortKeysDeep(content))
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

export function excludeStaleExtensionClients<
  S extends {
    clients: MCPServerConnection[]
    tools: NamedTool[]
    commands: NamedCommand[]
    resources: Record<string, ServerResource[]>
  },
>(mcpState: S, configs: Record<string, ScopedMcpServerConfig>): { state: S; staleClients: MCPServerConnection[] } {
  const staleClients = mcpState.clients.filter(client => {
    const fresh = configs[client.name]
    if (fresh !== undefined) return hashMcpConfig(fresh) !== hashMcpConfig(client.config)
    return client.config.scope === 'dynamic'
  })
  if (staleClients.length === 0) return { state: mcpState, staleClients: [] }
  const staleNames = new Set(staleClients.map(client => client.name))
  let tools = mcpState.tools
  let commands = mcpState.commands
  let resources = mcpState.resources
  for (const name of staleNames) {
    tools = excludeToolsByServer(tools, name)
    commands = excludeCommandsByServer(commands, name)
    resources = excludeResourcesByServer(resources, name)
  }
  return {
    state: {
      ...mcpState,
      clients: mcpState.clients.filter(client => !staleNames.has(client.name)),
      tools,
      commands,
      resources,
    },
    staleClients,
  }
}


export function describeMcpConfigFilePath(scope: ConfigScope | string): string {
  switch (scope) {
    case 'user':
      return getGlobalMercuryConfigPath()
    case 'project':
      return `${getCwd()}/.mcp.json`
    case 'local':
      return `${getGlobalMercuryConfigPath()} [project: ${getProjectPathForConfig()}]`
    case 'dynamic':
      return 'supplied at process start'
    case 'enterprise':
      return getEnterpriseMcpFilePath()
    case 'claudeai':
      return 'the claude.ai web account'
    default:
      return String(scope)
  }
}

function getGlobalMercuryConfigPath(): string {
  return getGlobalMercuryFile()
}

export function getScopeLabel(scope: ConfigScope | string): string {
  switch (scope) {
    case 'local':
      return 'Local (visible only to you in this project)'
    case 'project':
      return 'Project (shared with collaborators via .mcp.json)'
    case 'user':
      return 'User (available in all your projects)'
    case 'dynamic':
      return 'Dynamic (provided on the command line)'
    case 'enterprise':
      return 'Enterprise (administered by your organization)'
    case 'claudeai':
      return 'claude.ai (connected through your web account)'
    default:
      return String(scope)
  }
}

export const OPERATOR_CONFIG_SCOPES: readonly ConfigScope[] = ['local', 'user', 'project']

export function ensureConfigScope(scope?: string): ConfigScope {
  if (scope === undefined || scope === '') return 'local'
  if ((OPERATOR_CONFIG_SCOPES as readonly string[]).includes(scope)) return scope as ConfigScope
  throw new Error(`Invalid scope: ${scope}. Valid scopes are: ${OPERATOR_CONFIG_SCOPES.join(', ')}`)
}


export const MCP_CONNECT_TIMEOUT_TELEMETRY = 'MCP connection timeout'

export interface McpConnectFailureContext {
  transport: string
  command?: string
  url?: string
  stderrTail?: string
}

function errnoCodeInChain(error: unknown, maxDepth = 4): string | undefined {
  let cursor: unknown = error
  for (let depth = 0; depth <= maxDepth && cursor !== undefined && cursor !== null; depth++) {
    const code = getErrnoCode(cursor)
    if (code !== undefined) return code
    cursor = cursor instanceof Error ? cursor.cause : undefined
  }
  return undefined
}

function urlTarget(url: string | undefined): { host: string; target: string; port: string } {
  if (url === undefined) return { host: 'the server', target: 'the server', port: '' }
  try {
    const parsed = new URL(url)
    const port = parsed.port !== '' ? parsed.port : parsed.protocol === 'https:' ? '443' : '80'
    return { host: parsed.hostname, target: `${parsed.hostname}:${port}`, port }
  } catch {
    return { host: url, target: url, port: '' }
  }
}

function stripErrorClassPrefixes(text: string): string {
  return text.replace(/\b(?:TypeError|RangeError|Error|SseError|StreamableHTTPError|AggregateError):\s*/g, '')
}

export function describeMcpConnectFailure(error: unknown, context: McpConnectFailureContext): string {
  const message = errorMessage(error)
  if ((error as { telemetryMessage?: unknown } | null)?.telemetryMessage === MCP_CONNECT_TIMEOUT_TELEMETRY) return message
  const code = errnoCodeInChain(error)
  if (context.transport === 'stdio') {
    const command = context.command ?? 'the command'
    if (code === 'ENOENT') return `command not found: ${command} — check the path (or install it), then retry from /mcp`
    if (code === 'EACCES' || code === 'EPERM') return `command not executable: ${command} (${code}) — check its permissions, then retry from /mcp`
    const tail = (context.stderrTail ?? '').trim()
    return tail.length > 0
      ? `${message} — server stderr: ${tail}`
      : `${message} — the server wrote nothing to stderr before closing (run the command by hand to see why it exits)`
  }
  const { host, target, port } = urlTarget(context.url)
  const chain = errorMessageWithCause(error)
  if (code === 'ECONNREFUSED' || code === 'ConnectionRefused' || chain.includes('ECONNREFUSED') || chain.includes('Unable to connect')) {
    return `connection refused at ${target} — nothing is listening there; start the server, then retry from /mcp`
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /ENOTFOUND|EAI_AGAIN/.test(chain)) return `host not found: ${host} (DNS) — check the URL, then retry from /mcp`
  if (code === 'ECONNRESET' || chain.includes('ECONNRESET')) return `the connection to ${target} was reset — the server dropped it; retry from /mcp`
  if (code === 'ETIMEDOUT' || chain.includes('ETIMEDOUT')) return `connecting to ${target} timed out — check the network and the URL, then retry from /mcp`
  if (/certificate|CERT_|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(chain)) return `TLS certificate for ${host} not trusted (${stripErrorClassPrefixes(chain)}) — add its CA with NODE_EXTRA_CA_CERTS, then retry from /mcp`
  if (/bad port/i.test(chain)) return `port ${port || '(unset)'} is on fetch's blocked-port list — serve on another port, then retry from /mcp`
  return stripErrorClassPrefixes(chain)
}

export function clipToWord(text: string, max: number): string {
  if (max <= 1) return text.length <= max ? text : '…'
  if (text.length <= max) return text
  const head = text.slice(0, max - 1)
  const cut = head.lastIndexOf(' ')
  return `${(cut > max / 2 ? head.slice(0, cut) : head).trimEnd()}…`
}

const OPERATOR_SERVER_TYPES = ['stdio', 'sse', 'http', 'ws'] as const

type SchemaIssue = {
  code?: string
  path: ReadonlyArray<PropertyKey>
  message: string
  errors?: ReadonlyArray<ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>>
}

export function describeMcpConfigIssues(issues: ReadonlyArray<SchemaIssue>, parsed: unknown): string {
  const typed = parsed !== null && typeof parsed === 'object' ? (parsed as { type?: unknown }).type : undefined
  const typeWord = typeof typed === 'string' ? typed : undefined
  const flatten = (list: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): string[] =>
    list.map(issue => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
  const lines: string[] = []
  for (const issue of issues) {
    if (issue.code === 'invalid_union' && issue.errors !== undefined) {
      const matched = issue.errors.filter(branch => !branch.some(field => field.path.length === 1 && field.path[0] === 'type'))
      if (matched.length > 0) {
        const prefix = typeWord !== undefined ? `for a ${typeWord} server — ` : ''
        lines.push(`${prefix}${[...new Set(matched.flatMap(flatten))].join(' · ')}`)
        continue
      }
      lines.push(
        typeWord === undefined
          ? `type: missing — one of ${OPERATOR_SERVER_TYPES.join(', ')}`
          : `type: "${typeWord}" is not a server type — one of ${OPERATOR_SERVER_TYPES.join(', ')}`,
      )
      continue
    }
    lines.push(...flatten([issue]))
  }
  return [...new Set(lines)].join(' · ')
}

export function ensureTransport(type?: string): Transport {
  if (type === undefined || type === '') return 'stdio'
  if (type === 'stdio' || type === 'sse' || type === 'http') return type
  throw new Error(`Invalid transport type: ${type}. Valid types are: stdio, sse, http`)
}

export function parseHeaders(headerArray: string[]): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const header of headerArray) {
    const colonIndex = header.indexOf(':')
    if (colonIndex === -1) {
      throw new Error(`Invalid header format: "${header}". Expected "Header-Name: value"`)
    }
    const name = header.slice(0, colonIndex).trim()
    const value = header.slice(colonIndex + 1).trim()
    if (name === '') {
      throw new Error(`Invalid header format: "${header}". Header name cannot be empty`)
    }
    headers[name] = value
  }
  return headers
}


export function getProjectMcpServerStatus(
  serverName: string,
): 'approved' | 'rejected' | 'pending' {
  const settings = getInitialSettings()
  const normalized = normalizeNameForMCP(serverName)
  const matches = (names: string[] | undefined): boolean =>
    (names ?? []).some(name => normalizeNameForMCP(name) === normalized)

  if (matches(settings?.disabledMcpjsonServers)) return 'rejected'
  if (matches(settings?.enabledMcpjsonServers) || settings?.enableAllProjectMcpServers === true) {
    return 'approved'
  }

  const projectSourceEnabled = isSettingSourceEnabled('projectSettings')
  const skipSources = ['userSettings', 'localSettings', 'flagSettings', 'policySettings'] as const
  const dangerousSkip = skipSources.some(
    source => getSettingsForSource(source)?.skipDangerousModePermissionPrompt === true,
  )
  if (dangerousSkip && projectSourceEnabled) return 'approved'

  if (getIsNonInteractiveSession() && projectSourceEnabled && checkHasTrustDialogAccepted()) {
    return 'approved'
  }

  return 'pending'
}


export function getMcpServerScopeFromToolName(toolName: string): ConfigScope | undefined {
  const info = mcpInfoFromString(toolName)
  if (info === null) return undefined
  const config = getMcpConfigByName(info.serverName)
  if (config !== null) return config.scope
  if (info.serverName.startsWith('claude_ai_')) return 'claudeai'
  return undefined
}


export type AgentMcpServerRow = {
  name: string
  sourceAgents: string[]
  transport: 'stdio' | 'sse' | 'http' | 'ws'
  command?: string
  url?: string
  needsAuth: boolean
}

type AgentWithMcpServers = {
  agentType: string
  mcpServers?: Array<string | Record<string, McpServerConfig>>
}

export function extractAgentMcpServers(agents: AgentWithMcpServers[]): AgentMcpServerRow[] {
  const byName = new Map<string, { config: McpServerConfig; agents: string[] }>()
  for (const agent of agents) {
    for (const declaration of agent.mcpServers ?? []) {
      if (typeof declaration === 'string') continue
      const keys = Object.keys(declaration)
      if (keys.length !== 1) continue
      const name = keys[0] as string
      const config = declaration[name] as McpServerConfig
      const existing = byName.get(name)
      if (existing) {
        if (!existing.agents.includes(agent.agentType)) existing.agents.push(agent.agentType)
        continue
      }
      byName.set(name, { config, agents: [agent.agentType] })
    }
  }
  const rows: AgentMcpServerRow[] = []
  for (const [name, entry] of byName) {
    const config = entry.config as { type?: string; command?: string; url?: string }
    const rawTransport = config.type ?? 'stdio'
    if (
      rawTransport !== 'stdio' &&
      rawTransport !== 'sse' &&
      rawTransport !== 'http' &&
      rawTransport !== 'ws'
    ) {
      continue
    }
    const transport = rawTransport
    rows.push({
      name,
      sourceAgents: entry.agents,
      transport,
      ...(transport === 'stdio' ? { command: config.command } : { url: config.url }),
      needsAuth: transport === 'sse' || transport === 'http',
    })
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name))
}


export function getLoggingSafeMcpBaseUrl(
  config: McpServerConfig | ScopedMcpServerConfig,
): string | undefined {
  const url = (config as { url?: unknown }).url
  if (typeof url !== 'string') return undefined
  try {
    const parsed = new URL(url)
    parsed.search = ''
    parsed.hash = ''
    const text = parsed.toString()
    return text.endsWith('/') ? text.slice(0, -1) : text
  } catch {
    return undefined
  }
}
