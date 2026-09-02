/**
 * Server-scoped filtering/exclusion of tools, commands and resources; config
 * hashing and staleness; scope labelling; project-server approval status;
 * agent-declared server extraction; logging-safe URL derivation.
 *
 * Note: `utils.ts` and `config.ts` import each other — the cycle exists in
 * the audited source and is why `normalization.ts` and `mcpStringUtils.ts`
 * are separate, dependency-light modules. Reproduce the split; do not
 * "resolve" the cycle by merging.
 */
import { createHash } from 'node:crypto'

import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { checkHasTrustDialogAccepted } from '../../utils/config.js'
import { getProjectPathForConfig } from '../../utils/config.js'
import { getCwd } from '../../utils/cwd.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { getGlobalMercuryFile } from '../../utils/env.js'
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

// ---------------------------------------------------------------------------
// Server-scoped collections
// ---------------------------------------------------------------------------

type NamedTool = { name: string; mcpInfo?: { serverName?: string } }
type NamedCommand = { name: string; type?: string; source?: string; isMcp?: boolean }

/** True when the tool belongs to the server — matched on
 *  mcpInfo.serverName, the field every built MCP tool carries, with the
 *  qualified-prefix spelling as the fallback for info-less shapes. The
 *  prefix alone missed every tool whose wire-safe name took the SHORTENED
 *  server segment (a normalized server name past 42 characters pushes the
 *  qualified name over the 64-character wire cap; release-hardening audit
 *  rank 38): disabling or removing such a server cleared its roster row
 *  but left its tools in the session pool — a later call redialed the
 *  server the user had just turned off — reconnect refreshes appended
 *  duplicates, and the panel's per-server tool list showed none of them. */
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

/**
 * A command belongs to a server when it carries either naming shape: the
 * qualified-prompt prefix (`mcp__<server>__…`) or the skill prefix
 * (`<server>:…`). Both live in the same command collection, so per-server
 * filtering and cleanup must match either.
 */
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

/**
 * Prompts only (the MCP menu's capability badge): the server's commands minus
 * MCP-provided skills. A skill presents as a prompt-kind command carrying the
 * MCP load-source marker; MCP prompts proper leave that marker unset and
 * carry the MCP flag instead. Skills have their own surface elsewhere, so
 * counting them here would overstate how many prompts a server offers.
 */
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

/** Resources tagged with this server's name. */
export function filterResourcesByServer(
  resources: ServerResource[],
  serverName: string,
): ServerResource[] {
  return resources.filter(resource => resource.server === serverName)
}

/** Remove the server's key from the per-server resource map. */
export function excludeResourcesByServer(
  resources: Record<string, ServerResource[]>,
  serverName: string,
): Record<string, ServerResource[]> {
  const { [serverName]: _removed, ...rest } = resources
  return rest
}

/** Does this qualified tool name parse and name that server? */
export function isToolFromMcpServer(toolName: string, serverName: string): boolean {
  const info = mcpInfoFromString(toolName)
  return info !== null && info.serverName === normalizeNameForMCP(serverName)
}

/** An MCP tool at all: qualified name, or the MCP marker flag. */
export function isMcpTool(tool: { name: string; isMcp?: boolean }): boolean {
  return tool.name.startsWith('mcp__') || tool.isMcp === true
}

export function isMcpCommand(command: { name: string; isMcp?: boolean }): boolean {
  return command.name.startsWith('mcp__') || command.isMcp === true
}

// ---------------------------------------------------------------------------
// Config hashing and staleness
// ---------------------------------------------------------------------------

/** Sort object keys at every level; arrays keep their order. */
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

/**
 * A stable content hash of a server entry, with the scope annotation excluded
 * (scope is provenance, not content — moving a server between stores must not
 * force a reconnect) and keys sorted at every level. SHA-256 hex, truncated
 * to 16 characters; compared only against digests produced the same way.
 */
export function hashMcpConfig(config: McpServerConfig | ScopedMcpServerConfig): string {
  const { scope: _scope, ...content } = config as ScopedMcpServerConfig
  const canonical = JSON.stringify(sortKeysDeep(content))
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

/**
 * Drop stale connected clients and their tools/commands/resources.
 *
 * A client is stale when its config hash differs from the freshly-resolved
 * entry of the same name (any scope), or when the name is absent from the
 * fresh configuration AND the client's scope is `dynamic` — restricting the
 * disappearance case to that one scope is deliberate: a reload that only
 * partially repopulates the map must not tear down servers the user
 * configured by hand.
 *
 * When nothing is stale the input collections are returned unchanged (by
 * identity) so a re-render is not forced.
 */
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

// ---------------------------------------------------------------------------
// Scope descriptions and CLI argument parsing
// ---------------------------------------------------------------------------

/** Where a scope's entries are stored, as a human-readable location. */
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
  // The REAL file, from its one owner (globalConfig's resolver: the legacy
  // .config.json if present, else .mercury<suffix>.json) — this helper
  // previously named a config.json that has never existed, so every 'user'
  // scope line in mcp add/list receipts pointed at a phantom path.
  return getGlobalMercuryFile()
}

/** Human-readable meaning of each scope. */
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

const ALL_SCOPES: ConfigScope[] = [
  'local',
  'user',
  'project',
  'dynamic',
  'enterprise',
  'claudeai',
  'managed',
]

/**
 * Coerce a CLI scope argument. Absent ⇒ `local`; an unrecognised value
 * throws naming the value and listing every valid scope (the whole
 * vocabulary — `managed` is accepted here even though nothing in this slice
 * mints it).
 */
export function ensureConfigScope(scope?: string): ConfigScope {
  if (scope === undefined || scope === '') return 'local'
  if ((ALL_SCOPES as string[]).includes(scope)) return scope as ConfigScope
  throw new Error(`Invalid scope: ${scope}. Valid scopes are: ${ALL_SCOPES.join(', ')}`)
}

/**
 * Coerce a CLI transport argument. Absent ⇒ `stdio`; only `stdio`, `sse` and
 * `http` are accepted.
 */
export function ensureTransport(type?: string): Transport {
  if (type === undefined || type === '') return 'stdio'
  if (type === 'stdio' || type === 'sse' || type === 'http') return type
  throw new Error(`Invalid transport type: ${type}. Valid types are: stdio, sse, http`)
}

/**
 * Parse `Header-Name: value` CLI arguments. Split at the FIRST colon (values
 * may contain colons); both halves trimmed. Missing colon or an empty name
 * throw naming the offending argument.
 */
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

// ---------------------------------------------------------------------------
// Project-server approval
// ---------------------------------------------------------------------------

/**
 * Approval status of a project-scope (`.mcp.json`) server. Compared under
 * wire normalisation on both sides.
 *
 * Security requirement (do not weaken): the dangerous-mode permission-prompt
 * skip is read ONLY from the user, local, flag and policy settings sources —
 * never from the repository's own project settings, and the session bypass
 * mode is never consulted here. The dialog this stands in for is a consent
 * the HUMAN gives; a file inside the checkout answering it for them would be
 * the checkout consenting to its own execution.
 */
export function getProjectMcpServerStatus(
  serverName: string,
): 'approved' | 'rejected' | 'pending' {
  const settings = getInitialSettings()
  const normalized = normalizeNameForMCP(serverName)
  const matches = (names: string[] | undefined): boolean =>
    (names ?? []).some(name => normalizeNameForMCP(name) === normalized)

  // The optional-chain tolerance of an absent settings object is preserved
  // deliberately (removing it fails an end-to-end test).
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

  // The non-interactive auto-approval requires TRUST (FC-144): with no
  // dialog on this road, "headless implies consent" let a fresh checkout's
  // .mcp.json spawn on arrival — exactly the self-consent the docblock
  // above forbids. A workspace the operator trusted (interactively, once)
  // keeps the historical headless behavior.
  if (getIsNonInteractiveSession() && projectSourceEnabled && checkHasTrustDialogAccepted()) {
    return 'approved'
  }

  return 'pending'
}

// ---------------------------------------------------------------------------
// Scope from a tool name
// ---------------------------------------------------------------------------

/**
 * The scope of the server a qualified tool name refers to. Connector servers
 * are fetched asynchronously and absent from the config lookup, so a
 * normalised name beginning with `claude_ai_` falls back to the connector
 * scope. Anything else yields undefined.
 */
export function getMcpServerScopeFromToolName(toolName: string): ConfigScope | undefined {
  const info = mcpInfoFromString(toolName)
  if (info === null) return undefined
  const config = getMcpConfigByName(info.serverName)
  if (config !== null) return config.scope
  if (info.serverName.startsWith('claude_ai_')) return 'claudeai'
  return undefined
}

// ---------------------------------------------------------------------------
// Agent-declared MCP servers
// ---------------------------------------------------------------------------

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

/**
 * Extract inline agent-declared MCP servers, grouped by name.
 *
 * String references are skipped (they name servers that already exist);
 * inline objects with anything other than exactly one key are skipped; the
 * FIRST declaration's config wins while later agents accumulate as sources.
 * Only stdio/sse/http/ws transports are emitted (the SDK, connector-proxy
 * and IDE shapes are Mercury plumbing, not something an agent author
 * declared). Needs-auth is true exactly for `sse` and `http`.
 */
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

// ---------------------------------------------------------------------------
// Logging-safe URLs
// ---------------------------------------------------------------------------

/**
 * A base URL safe to log: the query string discarded (MCP endpoints routinely
 * carry credentials there) and a single trailing slash trimmed. Non-URL
 * entries and unparseable URLs yield undefined.
 */
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
