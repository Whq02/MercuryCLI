/**
 * Resolve, validate, merge, filter and mutate MCP server configuration across
 * all scopes; enforce the enterprise/managed policy gate; dedup extension and
 * connector entries against manually-configured servers.
 *
 * Scope authorities: `project` (.mcp.json walk), `user` (global config),
 * `local` (per-project section of the global store), `dynamic` (process
 * start), `enterprise` (managed MCP file), `claudeai` (web connectors).
 *
 * The export set of this file is pinned by the ownership contract inventory.
 * `utils.ts` and this file import each other — the cycle is deliberate (see
 * the module-split note in `utils.ts`).
 */
import { dirname, join, resolve } from 'node:path'

import { stripBOM } from '../../utils/jsonRead.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import {
  getCurrentProjectConfig,
  untrustedWorkspaceHeadless,
  getGlobalConfig,
  saveCurrentProjectConfig,
  saveGlobalConfig,
} from '../../utils/config.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { getCwd } from '../../utils/cwd.js'
import { durableAtomicPublish } from '../../substrate/durablePublish.js'
import { isSettingSourceEnabled } from '../../utils/settings/constants.js'
import { getManagedFilePath } from '../../utils/settings/managedPath.js'
import { isRestrictedToExtensionsOnly } from '../../utils/settings/extensionOnlyPolicy.js'
import { getInitialSettings, getSettingsForSource } from '../../utils/settings/settings.js'
import { getExtensionMcpServers } from '../../extensions/load/servers.js'
import { parseServerRuntimeName } from '../../extensions/manifest.js'
import { fetchClaudeAIMcpConfigsIfEligible } from './claudeai.js'
import { isMcpServerDisabledIn, withMcpServerEnabled } from './disabledRecord.js'
import { expandEnvVarsInString } from './envExpansion.js'
import {
  McpJsonConfigSchema,
  McpServerConfigSchema,
  type ConfigScope,
  type McpServerConfig,
  type ScopedMcpServerConfig,
} from './types.js'
import { getProjectMcpServerStatus } from './utils.js'

// ---------------------------------------------------------------------------
// Error records
// ---------------------------------------------------------------------------

/**
 * The validation-error record this slice publishes (S46's settings-error
 * aggregator consumes and renders it — a two-slice contract). Fatal errors
 * carry the scope and a fatal severity; warnings additionally carry the
 * server name.
 */
type McpConfigError = {
  filePath: string
  /** The offending path within the document; empty for whole-file failures. */
  path: string
  message: string
  suggestion?: string
  scope: ConfigScope
  serverName?: string
  severity: 'fatal' | 'warning'
}

/** The parsed document (entries scope-tagged), or null when the file is
 *  absent or failed to parse. Callers reach the entries via `.mcpServers`. */
type ParsedMcpDocument = { mcpServers: Record<string, ScopedMcpServerConfig> }

type ParseResult = {
  config: ParsedMcpDocument | null
  errors: McpConfigError[]
}

/** Internal flat view over a parse result. */
type ScopeRead = {
  servers: Record<string, ScopedMcpServerConfig>
  errors: McpConfigError[]
}

function flat(result: ParseResult): ScopeRead {
  return { servers: result.config?.mcpServers ?? {}, errors: result.errors }
}

// ---------------------------------------------------------------------------
// Reading files (typed absent-vs-broken distinction)
// ---------------------------------------------------------------------------

/**
 * A config file read is one of: absent (expected at every scope — never an
 * error), unreadable, invalid JSON, or content. The distinction is typed so
 * no caller ever string-matches a message to tell "absent" from "broken".
 */
type ConfigFileRead =
  | { kind: 'absent' }
  | { kind: 'unreadable'; message: string }
  | { kind: 'invalid-json'; message: string; contentLength: number; excerpt: string }
  | { kind: 'content'; value: unknown }

function readConfigFile(filePath: string): ConfigFileRead {
  const fs = getFsImplementation()
  if (!fs.existsSync(filePath)) return { kind: 'absent' }
  let raw: string
  try {
    raw = fs.readFileSync(filePath, { encoding: 'utf-8' })
  } catch (error) {
    return { kind: 'unreadable', message: error instanceof Error ? error.message : String(error) }
  }
  try {
    // BOM-stripped: PowerShell 5.1 / Notepad 'UTF-8 with BOM' write U+FEFF first and
    // JSON.parse died on it — every server in the scope silently failed with
    // 'fix the JSON syntax' on perfect JSON (TASK-017 S2, mcp-and-keybindings-json-no-bom-strip).
    return { kind: 'content', value: JSON.parse(stripBOM(raw)) }
  } catch (error) {
    return {
      kind: 'invalid-json',
      message: error instanceof Error ? error.message : String(error),
      contentLength: raw.length,
      excerpt: raw.slice(0, 80),
    }
  }
}

// ---------------------------------------------------------------------------
// Parsing + environment expansion
// ---------------------------------------------------------------------------

/** Expand env references across one entry, collecting missing names per entry. */
function expandServerConfig(
  config: McpServerConfig,
): { config: McpServerConfig; missingVars: string[] } {
  const missing = new Set<string>()
  const expand = (value: string): string => {
    const { expanded, missingVars } = expandEnvVarsInString(value)
    for (const name of missingVars) missing.add(name)
    return expanded
  }
  const type = (config as { type?: string }).type
  if (type === undefined || type === 'stdio') {
    const stdio = config as Extract<McpServerConfig, { command: string }>
    const expandedEnv =
      stdio.env === undefined
        ? undefined
        : Object.fromEntries(Object.entries(stdio.env).map(([key, value]) => [key, expand(value)]))
    return {
      config: {
        ...stdio,
        command: expand(stdio.command),
        args: (stdio.args ?? []).map(expand),
        ...(expandedEnv === undefined ? {} : { env: expandedEnv }),
      },
      missingVars: [...missing],
    }
  }
  if (type === 'sse' || type === 'http' || type === 'ws') {
    const remote = config as { url: string; headers?: Record<string, string> }
    const expandedHeaders =
      remote.headers === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(remote.headers).map(([key, value]) => [key, expand(value)]),
          )
    return {
      config: {
        ...(config as object),
        url: expand(remote.url),
        ...(expandedHeaders === undefined ? {} : { headers: expandedHeaders }),
      } as McpServerConfig,
      missingVars: [...missing],
    }
  }
  // IDE, SDK and connector-proxy entries pass through untouched.
  return { config, missingVars: [] }
}

/** The Windows `npx`-without-shell-wrapper warning (checked post-expansion). */
function windowsNpxWarning(
  serverName: string,
  config: McpServerConfig,
  scope: ConfigScope,
  filePath: string,
): McpConfigError | null {
  if (process.platform !== 'win32') return null
  const type = (config as { type?: string }).type
  if (type !== undefined && type !== 'stdio') return null
  const command = (config as { command?: string }).command ?? ''
  if (command !== 'npx' && !command.endsWith('/npx') && !command.endsWith('\\npx')) return null
  return {
    filePath,
    path: serverName,
    // Honest conditional (field FF2 w32-03: the old blanket "does not work"
    // painted one row above an npx server that had just connected).
    message: `MCP server "${serverName}" invokes "npx" directly — on some Windows setups this fails to start without a shell wrapper`,
    suggestion: `If the server fails to start, change the command to "cmd" and prepend ["/c", "${command}"] to the arguments`,
    scope,
    serverName,
    severity: 'warning',
  }
}

/**
 * Parse (and optionally env-expand) a config document. Invalid documents fail
 * whole: one fatal error PER schema issue, each carrying the issue's own
 * document path and the same generic message, none carrying a suggestion.
 */
export function parseMcpConfig({
  configObject,
  expandVars,
  scope,
  filePath,
}: {
  configObject: unknown
  expandVars: boolean
  scope: ConfigScope
  filePath?: string
}): ParseResult {
  const file = filePath ?? ''
  const parsed = McpJsonConfigSchema().safeParse(configObject)
  if (!parsed.success) {
    return {
      config: null,
      errors: parsed.error.issues.map(issue => ({
        filePath: file,
        path: issue.path.join('.'),
        message: 'does not match the MCP server configuration schema',
        scope,
        severity: 'fatal' as const,
      })),
    }
  }
  // Null-prototype: server names are user/config-supplied keys, and a server
  // named after an Object.prototype member ('__proto__', 'constructor') must
  // land as an ordinary entry, not corrupt or vanish from the map.
  const mcpServers: Record<string, ScopedMcpServerConfig> = Object.create(null) as Record<string, ScopedMcpServerConfig>
  const errors: McpConfigError[] = []
  for (const [serverName, serverConfig] of Object.entries(parsed.data.mcpServers)) {
    let effective = serverConfig as McpServerConfig
    if (expandVars) {
      const { config: expanded, missingVars } = expandServerConfig(effective)
      effective = expanded
      if (missingVars.length > 0) {
        errors.push({
          filePath: file,
          path: serverName,
          message: `MCP server "${serverName}" references unresolved environment variable(s): ${missingVars.join(', ')}`,
          suggestion: `Set the environment variable(s) ${missingVars.join(', ')} before starting`,
          scope,
          serverName,
          severity: 'warning',
        })
      }
    }
    const npxWarning = windowsNpxWarning(serverName, effective, scope, file)
    if (npxWarning !== null) errors.push(npxWarning)
    mcpServers[serverName] = { ...effective, scope } as ScopedMcpServerConfig
  }
  return { config: { mcpServers }, errors }
}

/**
 * Parse a config file. A missing file is EXPECTED at every scope and yields
 * zero errors; unreadable and invalid-JSON files yield one fatal error with a
 * remediation suggestion (and an error-level log — the JSON case with the
 * content length and a short excerpt so a truncated or HTML-substituted file
 * is diagnosable); schema failures are handled by `parseMcpConfig`.
 */
export function parseMcpConfigFromFilePath({
  filePath,
  expandVars,
  scope,
}: {
  filePath: string
  expandVars: boolean
  scope: ConfigScope
}): ParseResult {
  const read = readConfigFile(filePath)
  switch (read.kind) {
    case 'absent':
      return { config: null, errors: [] }
    case 'unreadable':
      logError(`Failed to read MCP config file ${filePath}: ${read.message}`)
      return {
        config: null,
        errors: [
          {
            filePath,
            path: '',
            message: `Failed to read MCP configuration file: ${read.message}`,
            suggestion: 'Check the file permissions and try again',
            scope,
            severity: 'fatal',
          },
        ],
      }
    case 'invalid-json':
      logError(
        `MCP config file ${filePath} is not valid JSON (${read.contentLength} bytes, starts with: ${read.excerpt}): ${read.message}`,
      )
      return {
        config: null,
        errors: [
          {
            filePath,
            path: '',
            message: `MCP configuration file is not valid JSON: ${read.message}`,
            suggestion: 'Fix the JSON syntax in the file',
            scope,
            severity: 'fatal',
          },
        ],
      }
    case 'content':
      return parseMcpConfig({ configObject: read.value, expandVars, scope, filePath })
  }
}

// ---------------------------------------------------------------------------
// Scope reads
// ---------------------------------------------------------------------------

/** Working directory and every ancestor, excluding the filesystem root. */
function projectDirectoryChain(): string[] {
  const chain: string[] = []
  let current = resolve(getCwd())
  while (true) {
    const parent = dirname(current)
    if (parent === current) break // `current` is the filesystem root — excluded.
    chain.push(current)
    current = parent
  }
  return chain
}

/** The full project walk: outermost first, so nearer files override. */
function getProjectMcpConfigs(): ScopeRead {
  if (!isSettingSourceEnabled('projectSettings')) return { servers: {}, errors: [] }
  const servers: Record<string, ScopedMcpServerConfig> = {}
  const errors: McpConfigError[] = []
  for (const directory of projectDirectoryChain().reverse()) {
    const result = flat(
      parseMcpConfigFromFilePath({
        filePath: join(directory, '.mcp.json'),
        expandVars: true,
        scope: 'project',
      }),
    )
    Object.assign(servers, result.servers)
    errors.push(...result.errors)
  }
  return { servers, errors }
}

/**
 * The current-directory-only project read, used by the add/remove mutators so
 * a mutation never rewrites an ancestor's file. Gated like the full walk.
 */
export function getProjectMcpConfigsFromCwd(): {
  servers: Record<string, ScopedMcpServerConfig>
  errors: McpConfigError[]
} {
  if (!isSettingSourceEnabled('projectSettings')) return { servers: {}, errors: [] }
  return flat(
    parseMcpConfigFromFilePath({
      filePath: join(getCwd(), '.mcp.json'),
      expandVars: true,
      scope: 'project',
    }),
  )
}

/** The managed MCP file path: `managed-mcp.json` beside the managed
 *  settings file, in the platform's managed-settings directory.
 *  getManagedFilePath() IS that directory — the dirname it once took here
 *  landed the file one level above the managed root, on the machine-wide
 *  config root itself (field F-2.2: C:\ProgramData\managed-mcp.json). */
export function getEnterpriseMcpFilePath(): string {
  return join(getManagedFilePath(), 'managed-mcp.json')
}

function getEnterpriseMcpConfigs(): ScopeRead {
  return flat(
    parseMcpConfigFromFilePath({
      filePath: getEnterpriseMcpFilePath(),
      expandVars: true,
      scope: 'enterprise',
    }),
  )
}

function getUserMcpConfigs(): ScopeRead {
  if (!isSettingSourceEnabled('userSettings')) return { servers: {}, errors: [] }
  const servers = getGlobalConfig().mcpServers
  if (!servers) return { servers: {}, errors: [] }
  return flat(
    parseMcpConfig({ configObject: { mcpServers: servers }, expandVars: true, scope: 'user' }),
  )
}

function getLocalMcpConfigs(): ScopeRead {
  if (!isSettingSourceEnabled('localSettings')) return { servers: {}, errors: [] }
  const servers = getCurrentProjectConfig().mcpServers
  if (!servers) return { servers: {}, errors: [] }
  return flat(
    parseMcpConfig({ configObject: { mcpServers: servers }, expandVars: true, scope: 'local' }),
  )
}

/** Read one scope's entries: `project | user | local | enterprise`. */
export function getMcpConfigsByScope(scope: 'project' | 'user' | 'local' | 'enterprise'): {
  servers: Record<string, ScopedMcpServerConfig>
  errors: McpConfigError[]
} {
  return scope === 'project'
    ? getProjectMcpConfigs()
    : scope === 'user'
      ? getUserMcpConfigs()
      : scope === 'local'
        ? getLocalMcpConfigs()
        : getEnterpriseMcpConfigs()
}

// ---------------------------------------------------------------------------
// Managed policy: allow-list and deny-list
// ---------------------------------------------------------------------------

type PolicyEntry = { serverName: string } | { serverCommand: string[] } | { serverUrl: string }

/** `*` matches any run of characters; every other metacharacter is literal. */
function urlGlobMatches(pattern: string, url: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, character =>
    character === '*' ? '.*' : `\\${character}`,
  )
  try {
    return new RegExp(`^${escaped}$`).test(url)
  } catch {
    return false
  }
}

function entryMatches(
  entry: PolicyEntry,
  serverName: string,
  config: McpServerConfig | undefined,
): boolean {
  if ('serverName' in entry) return entry.serverName === serverName
  if ('serverCommand' in entry) {
    if (config === undefined) return false
    const type = (config as { type?: string }).type
    if (type !== undefined && type !== 'stdio') return false
    const command = (config as { command?: string }).command
    if (command === undefined) return false
    const argv = [command, ...((config as { args?: string[] }).args ?? [])]
    return (
      entry.serverCommand.length === argv.length &&
      entry.serverCommand.every((element, index) => element === argv[index])
    )
  }
  const url = (config as { url?: string } | undefined)?.url
  if (typeof url !== 'string') return false
  return urlGlobMatches(entry.serverUrl, url)
}

const SETTINGS_SOURCES = [
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
] as const

/** Deny-lists merge from ALL settings sources — a user can always deny. */
function getDenyList(): PolicyEntry[] {
  const entries: PolicyEntry[] = []
  for (const source of SETTINGS_SOURCES) {
    const denied = getSettingsForSource(source)?.deniedMcpServers
    if (Array.isArray(denied)) entries.push(...(denied as PolicyEntry[]))
  }
  return entries
}

/** True when the policy settings source restricts to managed servers only. */
export function shouldAllowManagedMcpServersOnly(): boolean {
  return getSettingsForSource('policySettings')?.allowManagedMcpServersOnly === true
}

/**
 * The allow-list, or undefined when none is configured (absent ⇒ allow all;
 * an EMPTY list blocks everything). Under "allow only managed MCP servers"
 * the list is read exclusively from the policy settings source.
 */
function getAllowList(): PolicyEntry[] | undefined {
  if (shouldAllowManagedMcpServersOnly()) {
    return (getSettingsForSource('policySettings')?.allowedMcpServers ?? []) as PolicyEntry[]
  }
  const allowed = getInitialSettings()?.allowedMcpServers
  return allowed === undefined ? undefined : (allowed as PolicyEntry[])
}

function isServerDenied(serverName: string, config?: McpServerConfig): boolean {
  return getDenyList().some(entry => entryMatches(entry, serverName, config))
}

/**
 * Allow-list check with kind-specific matching: when the list contains ANY
 * command-based entry, every stdio server must match a command entry (name
 * matching no longer suffices); symmetrically for URL entries and remote
 * servers. Servers of unclassifiable shape use name matching only.
 */
function isServerAllowed(serverName: string, config?: McpServerConfig): boolean {
  const allowList = getAllowList()
  if (allowList === undefined) return true
  if (allowList.length === 0) return false
  const type = (config as { type?: string } | undefined)?.type
  const isStdio =
    config !== undefined && (type === undefined || type === 'stdio') && 'command' in (config as object)
  const isRemote = config !== undefined && typeof (config as { url?: unknown }).url === 'string'
  if (isStdio && allowList.some(entry => 'serverCommand' in entry)) {
    return allowList.some(
      entry => 'serverCommand' in entry && entryMatches(entry, serverName, config),
    )
  }
  if (isRemote && allowList.some(entry => 'serverUrl' in entry)) {
    return allowList.some(entry => 'serverUrl' in entry && entryMatches(entry, serverName, config))
  }
  return allowList.some(entry => 'serverName' in entry && entryMatches(entry, serverName, config))
}

/**
 * Partition a server map into allowed entries and blocked names, so callers
 * can warn about what was dropped. SDK-transport entries are exempt: nothing
 * is ever spawned or dialled for them, so no command- or URL-keyed rule can
 * describe one, and a name-only rule would quietly delete them the next time
 * the CLI carried its SDK servers forward. Tolerates structurally-partial
 * entries.
 */
export function filterMcpServersByPolicy<T>(
  configs: Record<string, T>,
): { allowed: Record<string, T>; blocked: string[] } {
  const allowed: Record<string, T> = {}
  const blocked: string[] = []
  for (const [name, config] of Object.entries(configs)) {
    if ((config as { type?: string } | undefined)?.type === 'sdk') {
      allowed[name] = config
      continue
    }
    if (
      isServerDenied(name, config as McpServerConfig) ||
      !isServerAllowed(name, config as McpServerConfig)
    ) {
      blocked.push(name)
      continue
    }
    allowed[name] = config
  }
  return { allowed, blocked }
}

// ---------------------------------------------------------------------------
// Enterprise exclusivity
// ---------------------------------------------------------------------------

let enterpriseMcpConfigExists: boolean | null = null

/**
 * Does the managed MCP file exist AND parse? Memoised on first call for the
 * process lifetime. A file that exists but is malformed reads as absent, so
 * exclusivity does not engage on a broken file.
 */
export function doesEnterpriseMcpConfigExist(): boolean {
  if (enterpriseMcpConfigExists === null) {
    const read = readConfigFile(getEnterpriseMcpFilePath())
    enterpriseMcpConfigExists =
      read.kind === 'content' && McpJsonConfigSchema().safeParse(read.value).success
  }
  return enterpriseMcpConfigExists
}

/**
 * Would `configs` be acceptable alongside an enterprise MCP config? Current
 * rule: only when EVERY entry is an SDK-type entry named `mercury-editor`.
 * The narrowness is the point — a targeted carve-out keeping the editor
 * extension working under managed MCP, not a general policy about SDK
 * servers. Re-implemented as-is; do not generalise silently.
 */
export function areMcpConfigsAllowedWithEnterpriseMcpConfig(
  configs: Record<string, McpServerConfig | ScopedMcpServerConfig>,
): boolean {
  return Object.entries(configs).every(
    ([name, config]) => (config as { type?: string }).type === 'sdk' && name === 'mercury-editor',
  )
}

// ---------------------------------------------------------------------------
// Signatures and duplicate suppression
// ---------------------------------------------------------------------------

/**
 * Two servers are "the same server" when their signature matches: the ordered
 * command array for stdio entries, the proxy-unwrapped URL for remote
 * entries. SDK entries have no signature and are never deduped. Env and
 * headers are deliberately excluded — every extension entry carries an
 * injected root variable, and two entries pointing at one endpoint are one
 * server however they authenticate.
 */
export function getMcpServerSignature(
  config: McpServerConfig | ScopedMcpServerConfig,
): string | undefined {
  const record = config as { type?: string; command?: string; args?: string[]; url?: string }
  if (typeof record.url === 'string') return record.url
  if (typeof record.command === 'string') {
    return JSON.stringify([record.command, ...(record.args ?? [])])
  }
  return undefined
}

/** Signature → first name to claim it (that name is reported as the survivor). */
function indexBySignature(
  configs: Record<string, McpServerConfig | ScopedMcpServerConfig>,
): Map<string, string> {
  const index = new Map<string, string>()
  for (const [name, config] of Object.entries(configs)) {
    const signature = getMcpServerSignature(config)
    if (signature === undefined) continue
    if (!index.has(signature)) index.set(signature, name)
  }
  return index
}

/** Manual entries that would genuinely open a connection (enabled + allowed). */
function narrowToConnectable<T extends McpServerConfig | ScopedMcpServerConfig>(
  configs: Record<string, T>,
): Record<string, T> {
  const connectable: Record<string, T> = {}
  for (const [name, config] of Object.entries(configs)) {
    if (isMcpServerDisabled(name)) continue
    if (isServerDenied(name, config) || !isServerAllowed(name, config)) continue
    connectable[name] = config
  }
  return connectable
}

type DedupResult = {
  servers: Record<string, ScopedMcpServerConfig>
  suppressed: Array<{ name: string; duplicateOf: string }>
}

/**
 * Extension dedup: a manually-configured entry always beats an extension
 * entry; among extension entries the earliest loaded keeps the slot. Both
 * sides are restricted to entries that would genuinely connect — a disabled
 * manual server must not suppress its extension twin (leaving neither
 * running), and a disabled/blocked extension entry is held aside so it
 * cannot win the earliest-loaded race, then merged back so it still appears
 * in the UI.
 */
export function dedupExtensionMcpServers(
  extensionServers: Record<string, ScopedMcpServerConfig>,
  manualServers: Record<string, McpServerConfig | ScopedMcpServerConfig>,
): DedupResult {
  const targetIndex = indexBySignature(narrowToConnectable(manualServers))
  const servers: Record<string, ScopedMcpServerConfig> = {}
  const heldAside: Record<string, ScopedMcpServerConfig> = {}
  const suppressed: Array<{ name: string; duplicateOf: string }> = []
  for (const [name, config] of Object.entries(extensionServers)) {
    const connectable =
      !isMcpServerDisabled(name) && !isServerDenied(name, config) && isServerAllowed(name, config)
    if (!connectable) {
      heldAside[name] = config
      continue
    }
    const signature = getMcpServerSignature(config)
    if (signature !== undefined) {
      const existing = targetIndex.get(signature)
      if (existing !== undefined) {
        suppressed.push({ name, duplicateOf: existing })
        logForDebugging(`MCP dedup: extension server "${name}" duplicates "${existing}", suppressed`)
        continue
      }
      targetIndex.set(signature, name)
    }
    servers[name] = config
  }
  for (const [name, config] of Object.entries(heldAside)) {
    if (!(name in servers)) servers[name] = config
  }
  return { servers, suppressed }
}

/**
 * Connector dedup: a connector is suppressed when its signature matches an
 * ENABLED manual entry — editing a config file or running the add command is
 * a deliberate act, while a web-UI connector toggle is a weaker signal, so
 * the local declaration survives.
 */
export function dedupClaudeAiMcpServers(
  connectorServers: Record<string, ScopedMcpServerConfig>,
  manualServers: Record<string, McpServerConfig | ScopedMcpServerConfig>,
): DedupResult {
  const targetIndex = indexBySignature(narrowToConnectable(manualServers))
  const servers: Record<string, ScopedMcpServerConfig> = {}
  const suppressed: Array<{ name: string; duplicateOf: string }> = []
  for (const [name, config] of Object.entries(connectorServers)) {
    const signature = getMcpServerSignature(config)
    if (signature !== undefined) {
      const existing = targetIndex.get(signature)
      if (existing !== undefined) {
        suppressed.push({ name, duplicateOf: existing })
        logForDebugging(
          `MCP dedup: claude.ai connector "${name}" duplicates "${existing}", suppressed`,
        )
        continue
      }
      targetIndex.set(signature, name)
    }
    servers[name] = config
  }
  return { servers, suppressed }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** A notice from resolution: an extension server suppressed as a duplicate of an operator server. */
export type McpResolutionNotice = {
  kind: 'suppressed-duplicate'
  /** The runtime name `ext:<name>:<server>`. */
  server: string
  extensionName: string
  duplicateOf: string
  message: string
}

/** Every approved extension's MCP servers, from the active set (never a fetch). */
function getExtensionProvidedMcpServers(): Record<string, ScopedMcpServerConfig> {
  try {
    return getExtensionMcpServers()
  } catch (error) {
    logForDebugging(`MCP extension server loading failed: ${String(error)}`)
    return {}
  }
}

/**
 * Suppression notices as informational records, carrying the runtime name,
 * the extension's name, and the duplicated entry's name so the board can
 * show them. A suppressed key that is not an extension server is skipped.
 */
function suppressionNotices(suppressed: Array<{ name: string; duplicateOf: string }>): McpResolutionNotice[] {
  const notices: McpResolutionNotice[] = []
  for (const { name, duplicateOf } of suppressed) {
    const parsed = parseServerRuntimeName(name)
    if (parsed === null) continue
    notices.push({
      kind: 'suppressed-duplicate',
      server: name,
      extensionName: parsed.name,
      duplicateOf,
      message: `MCP server "${parsed.server}" from extension "${parsed.name}" was suppressed as a duplicate of "${duplicateOf}"`,
    })
  }
  return notices
}

/**
 * The fast resolution path: the effective server map plus the resolution
 * notices (parse errors surface through the per-scope readers instead). No
 * awaited network on the critical path — extension servers come from the
 * active set. Dynamic entries and extra dedup targets take part ONLY as
 * dedup targets; whoever passed them owns merging them into the effective
 * set.
 */
export async function getMercuryMcpConfigs(
  dynamicServers?: Record<string, ScopedMcpServerConfig>,
  extraDedupTargets?: Promise<Record<string, ScopedMcpServerConfig>>,
): Promise<{ servers: Record<string, ScopedMcpServerConfig>; errors: McpResolutionNotice[] }> {
  // Enterprise exclusivity: the managed file takes exclusive control over all MCP servers.
  if (doesEnterpriseMcpConfigExist()) {
    const enterprise = getEnterpriseMcpConfigs()
    const { allowed } = filterMcpServersByPolicy(enterprise.servers)
    return { servers: allowed, errors: [] }
  }

  const emptyRead: ScopeRead = { servers: {}, errors: [] }
  const mcpLocked = isRestrictedToExtensionsOnly('mcp')
  // Untrusted workspace on the headless road (FC-144): .mcp.json is
  // checkout-delivered executable config — its servers do not participate
  // at all in a directory the operator never trusted (the interactive road
  // gates them behind trust + the per-server approval dialog). User and
  // local scopes live OUTSIDE the checkout (config home / global config)
  // and still apply.
  const projectUntrusted = untrustedWorkspaceHeadless()
  if (projectUntrusted) {
    logForDebugging(
      'mcp: untrusted workspace on a non-interactive road — .mcp.json servers are not loaded (boot interactively once here to trust this directory)',
    )
  }
  const user = mcpLocked ? emptyRead : getUserMcpConfigs()
  const project = mcpLocked || projectUntrusted ? emptyRead : getProjectMcpConfigs()
  const local = mcpLocked ? emptyRead : getLocalMcpConfigs()

  const extensionServers = getExtensionProvidedMcpServers()

  // Project-server approval: only approved project servers participate.
  const approvedProject: Record<string, ScopedMcpServerConfig> = {}
  for (const [name, config] of Object.entries(project.servers)) {
    if (getProjectMcpServerStatus(name) === 'approved') approvedProject[name] = config
  }

  const extraTargets = extraDedupTargets === undefined ? {} : await extraDedupTargets

  // The dedup-target set: manual servers that will actually connect (later
  // keys win on collision); dynamic entries participate here ONLY.
  const dedupTargets: Record<string, ScopedMcpServerConfig> = {
    ...user.servers,
    ...approvedProject,
    ...local.servers,
    ...(dynamicServers ?? {}),
    ...extraTargets,
  }
  const { servers: dedupedExtensions, suppressed } = dedupExtensionMcpServers(
    extensionServers,
    dedupTargets,
  )

  // Merge in order of precedence: extension < user < project < local
  // (later spreads win — extension is the weakest scope).
  const merged: Record<string, ScopedMcpServerConfig> = {
    ...dedupedExtensions,
    ...user.servers,
    ...approvedProject,
    ...local.servers,
  }

  const { allowed } = filterMcpServersByPolicy(merged)
  return { servers: allowed, errors: suppressionNotices(suppressed) }
}

/**
 * The full resolution path: additionally fetches connector servers,
 * policy-filters them, dedups them against the resolved set, and merges them
 * at the LOWEST precedence of all. The connector fetch is started BEFORE
 * the Mercury-side resolution so the two overlap (it is memoised — one
 * network call per session however many consumers await it). Skipped
 * entirely under enterprise exclusivity.
 */
export async function getAllMcpConfigs(): Promise<{
  servers: Record<string, ScopedMcpServerConfig>
  errors: McpResolutionNotice[]
}> {
  if (doesEnterpriseMcpConfigExist()) {
    return getMercuryMcpConfigs()
  }
  const connectorFetch = fetchClaudeAIMcpConfigsIfEligible()
  const resolved = await getMercuryMcpConfigs()
  const connectors = await connectorFetch
  if (Object.keys(connectors).length === 0) return resolved
  const { allowed: allowedConnectors } = filterMcpServersByPolicy(connectors)
  const { servers: dedupedConnectors } = dedupClaudeAiMcpServers(
    allowedConnectors,
    resolved.servers,
  )
  return {
    servers: { ...dedupedConnectors, ...resolved.servers },
    errors: resolved.errors,
  }
}

/**
 * Single-name lookup, precedence enterprise → local → project → user. Under
 * the extensions-only lock the lookup resolves only against enterprise entries.
 */
export function getMcpConfigByName(name: string): ScopedMcpServerConfig | null {
  const enterprise = getEnterpriseMcpConfigs().servers
  if (name in enterprise) return enterprise[name] ?? null
  if (isRestrictedToExtensionsOnly('mcp')) return null
  const local = getLocalMcpConfigs().servers
  if (name in local) return local[name] ?? null
  const project = getProjectMcpConfigs().servers
  if (name in project) return project[name] ?? null
  const user = getUserMcpConfigs().servers
  if (name in user) return user[name] ?? null
  return null
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

/** Strip scope annotations before anything is written back to disk. */
function stripScope(config: McpServerConfig | ScopedMcpServerConfig): McpServerConfig {
  const { scope: _scope, ...rest } = config as ScopedMcpServerConfig
  return rest as McpServerConfig
}

/** Rewrite the working directory's `.mcp.json` atomically and crash-safe. */
async function writeProjectMcpFile(
  servers: Record<string, McpServerConfig | ScopedMcpServerConfig>,
): Promise<void> {
  const mcpJsonPath = join(getCwd(), '.mcp.json')
  const fs = getFsImplementation()
  let mode = 0o644
  try {
    if (fs.existsSync(mcpJsonPath)) {
      mode = fs.statSync(mcpJsonPath).mode & 0o777
    }
  } catch {
    // Keep the default mode when the stat fails.
  }
  const document = {
    mcpServers: Object.fromEntries(
      Object.entries(servers).map(([name, config]) => [name, stripScope(config)]),
    ),
  }
  try {
    await durableAtomicPublish(mcpJsonPath, `${JSON.stringify(document, null, 2)}\n`, { mode })
  } catch (error) {
    throw new Error(
      `Failed to write to ${mcpJsonPath}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Add a server. Validation order (first failure refuses): name charset →
 * reserved in-process name → enterprise exclusivity → schema → deny-list →
 * allow-list → per-scope existing-name check / scope mutability.
 */
export async function addMcpConfig(
  name: string,
  config: unknown,
  scope: ConfigScope,
): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(
      `Invalid MCP server name "${name}": names may only contain letters, numbers, hyphens and underscores`,
    )
  }

  // The in-process coordination server reserves its name while enabled.
  const coordination = await import('./coordinationServer.js')
  if (coordination.isCoordinationServerEnabled() && coordination.isCoordinationServer(name)) {
    throw new Error(
      `"${name}" is reserved for Mercury's in-process coordination MCP server (disable with MERCURY_COORDINATION_MCP=0)`,
    )
  }

  if (doesEnterpriseMcpConfigExist()) {
    throw new Error(
      `Cannot add MCP server: the managed MCP configuration file (${getEnterpriseMcpFilePath()}) is in force and alone decides which MCP servers exist`,
    )
  }

  const validated = McpServerConfigSchema().safeParse(config)
  if (!validated.success) {
    const details = validated.error.issues
      .map(issue => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ')
    throw new Error(`Invalid MCP server configuration: ${details}`)
  }
  const effective = validated.data

  if (isServerDenied(name, effective)) {
    throw new Error(`MCP server "${name}" is explicitly blocked by enterprise policy`)
  }
  if (!isServerAllowed(name, effective)) {
    throw new Error(`MCP server "${name}" is not allowed by enterprise policy`)
  }

  switch (scope) {
    case 'project': {
      // The repo-visible .mcp.json is a read-modify-write with concurrent
      // writers (FC-036: eight racing adds all reported success and five
      // were silently discarded) — serialized under the config lock family
      // with its contention retries.
      const mcpJsonPath = join(getCwd(), '.mcp.json')
      const { runExclusiveOnFileSync } = await import('../../utils/config/globalConfig.js')
      await runExclusiveOnFileSync(mcpJsonPath, async () => {
        const existing = getProjectMcpConfigsFromCwd().servers
        if (name in existing) {
          throw new Error(`MCP server "${name}" already exists in .mcp.json`)
        }
        await writeProjectMcpFile({ ...existing, [name]: effective })
      })
      return
    }
    case 'user': {
      if (name in (getGlobalConfig().mcpServers ?? {})) {
        throw new Error(`MCP server "${name}" already exists in the user config`)
      }
      saveGlobalConfig(current => ({
        ...current,
        mcpServers: { ...(current.mcpServers ?? {}), [name]: effective },
      }))
      return
    }
    case 'local': {
      if (name in (getCurrentProjectConfig().mcpServers ?? {})) {
        throw new Error(`MCP server "${name}" already exists in the local config`)
      }
      saveCurrentProjectConfig(current => ({
        ...current,
        mcpServers: { ...(current.mcpServers ?? {}), [name]: effective },
      }))
      return
    }
    case 'dynamic':
    case 'enterprise':
    case 'claudeai':
      throw new Error(`Cannot add an MCP server to the ${scope} scope`)
    default:
      throw new Error(`Cannot add an MCP server to the ${String(scope)} scope`)
  }
}

/** Remove a server from a mutable scope; the miss message names the store. */
export async function removeMcpConfig(name: string, scope: ConfigScope): Promise<void> {
  switch (scope) {
    case 'project': {
      // Same FC-036 serialization as the add arm: a raced remove printed
      // Removed while the server stayed registered.
      const mcpJsonPath = join(getCwd(), '.mcp.json')
      const { runExclusiveOnFileSync } = await import('../../utils/config/globalConfig.js')
      await runExclusiveOnFileSync(mcpJsonPath, async () => {
        const existing = getProjectMcpConfigsFromCwd().servers
        if (!(name in existing)) {
          throw new Error(`MCP server "${name}" does not exist in .mcp.json`)
        }
        const { [name]: _removed, ...rest } = existing
        await writeProjectMcpFile(rest)
      })
      return
    }
    case 'user': {
      const servers = getGlobalConfig().mcpServers ?? {}
      if (!(name in servers)) {
        throw new Error(`MCP server "${name}" is not user-scoped`)
      }
      saveGlobalConfig(current => {
        const { [name]: _removed, ...rest } = current.mcpServers ?? {}
        return { ...current, mcpServers: rest }
      })
      return
    }
    case 'local': {
      const servers = getCurrentProjectConfig().mcpServers ?? {}
      if (!(name in servers)) {
        throw new Error(`MCP server "${name}" is not in the project-local config`)
      }
      saveCurrentProjectConfig(current => {
        const { [name]: _removed, ...rest } = current.mcpServers ?? {}
        return { ...current, mcpServers: rest }
      })
      return
    }
    default:
      throw new Error(`Cannot remove an MCP server from the ${String(scope)} scope`)
  }
}

// ---------------------------------------------------------------------------
// Enable / disable
// ---------------------------------------------------------------------------

// The semantics live in the zero-dependency leaf disabledRecord.ts (the
// default-disabled built-ins set, the opt-out/opt-in reading, the pure
// updater) so the daemon's workspace-keyed kit derivation answers "is this
// name off" from an explicit slice without this module's resolution graph.
// The two doors below are THIS process's project, through the cwd key.

/**
 * Is this server disabled on disk? Most servers are governed by the
 * `disabledMcpServers` (opt-out) list; default-disabled built-ins are
 * governed by the `enabledMcpServers` (opt-in) list instead.
 */
export function isMcpServerDisabled(name: string): boolean {
  return isMcpServerDisabledIn(getCurrentProjectConfig(), name)
}

/**
 * Persist a server's enabled state. Toggling to the state a server already
 * has returns the previous configuration object BY IDENTITY, so the store's
 * change detection skips the write. (The workspace-keyed twin — the menu's
 * pen after a ground move, the daemon's — is kitStore.ts's
 * setMcpServerEnabledForWorkspace over the same updater.)
 */
export function setMcpServerEnabled(name: string, enabled: boolean): void {
  saveCurrentProjectConfig(current => withMcpServerEnabled(current, name, enabled))
}
