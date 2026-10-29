import { dirname, join, resolve } from 'node:path'

import { z } from 'zod'

import { stripBOM } from '../../utils/jsonRead.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import {
  checkHasTrustDialogAccepted,
  getCurrentProjectConfig,
  untrustedWorkspaceHeadless,
  getGlobalConfig,
  saveCurrentProjectConfig,
  saveGlobalConfig,
} from '../../utils/config.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { getCwd } from '../../utils/cwd.js'
import { MERCURY_PROJECT_DIR, projectConfigDirs } from '../../utils/projectConfig.js'
import { durableAtomicPublish } from '../../substrate/durablePublish.js'
import { isSettingSourceEnabled } from '../../utils/settings/constants.js'
import { getManagedFilePath } from '../../utils/settings/managedPath.js'
import { isRestrictedToExtensionsOnly } from '../../utils/settings/extensionOnlyPolicy.js'
import { getInitialSettings, getSettingsForSource } from '../../utils/settings/settings.js'
import { getExtensionMcpServers } from '../../extensions/load/servers.js'
import { parseServerRuntimeName } from '../../extensions/manifest.js'
import { fetchAnthropicConnectorsIfEligible } from './anthropicConnectors.js'
import { isMcpServerDisabledIn, withMcpServerEnabled } from './disabledRecord.js'
import { expandEnvVarsInString } from './envExpansion.js'
import { mcpStdioCommandRefusal } from './stdioCommandSafety.js'
import {
  McpServerConfigSchema,
  type ConfigScope,
  type McpServerConfig,
  type McpUnexpandedStrings,
  type ScopedMcpServerConfig,
} from './types.js'
import { getProjectMcpServerStatus } from './utils.js'

type McpConfigError = {
  filePath: string

  path: string
  message: string
  suggestion?: string
  scope: ConfigScope
  serverName?: string
  severity: 'fatal' | 'warning'
}

type ParsedMcpDocument = { mcpServers: Record<string, ScopedMcpServerConfig> }

type ParseResult = {
  config: ParsedMcpDocument | null
  errors: McpConfigError[]
  notices: string[]
}

type ScopeRead = {
  servers: Record<string, ScopedMcpServerConfig>
  errors: McpConfigError[]
  notices: string[]
}

function flat(result: ParseResult): ScopeRead {
  return { servers: result.config?.mcpServers ?? {}, errors: result.errors, notices: result.notices }
}

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

function expandServerConfig(
  config: McpServerConfig,
): { config: McpServerConfig; missingVars: string[]; unexpanded?: McpUnexpandedStrings } {
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
    const command = expand(stdio.command)
    const args = (stdio.args ?? []).map(expand)
    const unexpanded: McpUnexpandedStrings = {
      ...(command === stdio.command ? {} : { command: stdio.command }),
      ...(args.every((value, index) => value === stdio.args?.[index]) ? {} : { args: [...(stdio.args ?? [])] }),
    }
    return {
      config: {
        ...stdio,
        command,
        args,
        ...(expandedEnv === undefined ? {} : { env: expandedEnv }),
      },
      missingVars: [...missing],
      ...(Object.keys(unexpanded).length === 0 ? {} : { unexpanded }),
    }
  }
  if (type === 'sse' || type === 'http' || type === 'ws') {
    const remote = config as { url: string; headers?: Record<string, string>; oauth?: { clientId?: string; authServerMetadataUrl?: string } }
    const expandedHeaders =
      remote.headers === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(remote.headers).map(([key, value]) => [key, expand(value)]),
          )
    const expandedOauth =
      remote.oauth === undefined
        ? undefined
        : {
            ...remote.oauth,
            ...(remote.oauth.clientId === undefined ? {} : { clientId: expand(remote.oauth.clientId) }),
            ...(remote.oauth.authServerMetadataUrl === undefined ? {} : { authServerMetadataUrl: expand(remote.oauth.authServerMetadataUrl) }),
          }
    const url = expand(remote.url)
    return {
      config: {
        ...(config as object),
        url,
        ...(expandedHeaders === undefined ? {} : { headers: expandedHeaders }),
        ...(expandedOauth === undefined ? {} : { oauth: expandedOauth }),
      } as McpServerConfig,
      missingVars: [...missing],
      ...(url === remote.url ? {} : { unexpanded: { url: remote.url } }),
    }
  }

  return { config, missingVars: [] }
}

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

    message: `MCP server "${serverName}" invokes "npx" directly — on some Windows setups this fails to start without a shell wrapper`,
    suggestion: `If the server fails to start, change the command to "cmd" and prepend ["/c", "${command}"] to the arguments`,
    scope,
    serverName,
    severity: 'warning',
  }
}

const SCHEMA_MISMATCH = 'does not match the MCP server configuration schema'

const McpDocumentShape = z.object({ mcpServers: z.record(z.string(), z.unknown()) })
export const MCP_SERVERS_MAX_PER_DOCUMENT = 64

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
  const document = McpDocumentShape.safeParse(configObject)
  if (!document.success) {
    return {
      config: null,
      errors: document.error.issues.map(issue => ({
        filePath: file,
        path: issue.path.join('.'),
        message: SCHEMA_MISMATCH,
        scope,
        severity: 'fatal' as const,
      })),
      notices: [],
    }
  }

  const mcpServers: Record<string, ScopedMcpServerConfig> = Object.create(null) as Record<string, ScopedMcpServerConfig>
  const errors: McpConfigError[] = []
  const entries = Object.entries(document.data.mcpServers)
  const notices = filePath !== undefined && entries.length > MCP_SERVERS_MAX_PER_DOCUMENT
    ? [`MCP file ${file}: ${entries.length.toLocaleString('en-US')} servers, the first ${MCP_SERVERS_MAX_PER_DOCUMENT} loaded`]
    : []
  const keptEntries = filePath === undefined ? entries : entries.slice(0, MCP_SERVERS_MAX_PER_DOCUMENT)
  for (const [serverName, rawEntry] of keptEntries) {
    const entry = McpServerConfigSchema().safeParse(rawEntry)
    if (!entry.success) {
      errors.push({
        filePath: file,
        path: `mcpServers.${serverName}`,
        message: SCHEMA_MISMATCH,
        scope,
        serverName,
        severity: 'warning',
      })
      continue
    }
    let effective = entry.data as McpServerConfig
    let unexpanded: McpUnexpandedStrings | undefined
    if (expandVars) {
      const { config: expanded, missingVars, unexpanded: written } = expandServerConfig(effective)
      effective = expanded
      unexpanded = written
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
    const refusal = mcpStdioCommandRefusal(serverName, effective)
    if (refusal !== null) {
      errors.push({ filePath: file, path: `mcpServers.${serverName}`, message: refusal, scope, serverName, severity: 'warning' })
      continue
    }
    const npxWarning = windowsNpxWarning(serverName, effective, scope, file)
    if (npxWarning !== null) errors.push(npxWarning)
    mcpServers[serverName] = { ...effective, scope, ...(unexpanded === undefined ? {} : { unexpanded }) } as ScopedMcpServerConfig
  }
  return { config: { mcpServers }, errors, notices }
}

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
      return { config: null, errors: [], notices: [] }
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
        notices: [],
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
        notices: [],
      }
    case 'content':
      return parseMcpConfig({ configObject: read.value, expandVars, scope, filePath })
  }
}

function projectDirectoryChain(): string[] {
  const chain: string[] = []
  let current = resolve(getCwd())
  while (true) {
    const parent = dirname(current)
    if (parent === current) break
    chain.push(current)
    current = parent
  }
  return chain
}

export const PROJECT_MCP_FILE = 'mcp.json'

export function projectMcpFilePath(dir: string): string {
  return join(projectConfigDirs(dir)[0], PROJECT_MCP_FILE)
}

function lockedProjectMcpFile(): string {
  const path = projectMcpFilePath(getCwd())
  getFsImplementation().mkdirSync(dirname(path))
  return path
}

export function getProjectMcpConfigs(): ScopeRead {
  if (!isSettingSourceEnabled('projectSettings')) return { servers: {}, errors: [], notices: [] }
  const servers: Record<string, ScopedMcpServerConfig> = {}
  const errors: McpConfigError[] = []
  const notices: string[] = []
  for (const directory of projectDirectoryChain().reverse()) {
    const result = flat(
      parseMcpConfigFromFilePath({
        filePath: projectMcpFilePath(directory),
        expandVars: true,
        scope: 'project',
      }),
    )
    Object.assign(servers, result.servers)
    errors.push(...result.errors)
    notices.push(...result.notices)
  }
  return { servers, errors, notices }
}

export function getProjectMcpConfigsFromCwd(): {
  servers: Record<string, ScopedMcpServerConfig>
  errors: McpConfigError[]
  notices: string[]
} {
  if (!isSettingSourceEnabled('projectSettings')) return { servers: {}, errors: [], notices: [] }
  return flat(
    parseMcpConfigFromFilePath({
      filePath: projectMcpFilePath(getCwd()),
      expandVars: true,
      scope: 'project',
    }),
  )
}

export function mcpServersSkippedForTrustLine(): string | null {
  if (!untrustedWorkspaceHeadless()) return null
  let count = 0
  try {
    count = Object.keys(getProjectMcpConfigsFromCwd().servers).length
  } catch {
    count = 0
  }
  if (count === 0) return null
  return skippedForTrustSentence(count === 1 ? 'its 1 project MCP server was' : `its ${count} project MCP servers were`, count === 1)
}

function skippedForTrustSentence(subject: string, singular: boolean): string {
  return `mcp: this folder is not trusted, so ${subject} not loaded from ${PROJECT_MCP_FILE_SPELLING} — start Mercury here once and accept the trust card, and ${singular ? 'it connects' : 'they connect'}`
}

export function mcpServerSkippedForTrustLine(name: string, config: ScopedMcpServerConfig): string | null {
  if (config.scope !== 'project') return null
  let trusted = true
  try {
    trusted = checkHasTrustDialogAccepted()
  } catch {
    trusted = true
  }
  if (trusted) return null
  return skippedForTrustSentence(`its project MCP server ${name} was`, true)
}

export function mcpServerSkippedForApprovalLine(name: string, config: ScopedMcpServerConfig): string | null {
  if (config.scope !== 'project') return null
  if (getProjectMcpServerStatus(name, config) === 'approved') return null
  return `MCP server ${name} (project) skipped: not approved · open Mercury in this folder to approve it`
}

export function mcpServersSkippedForApprovalLines(): Array<{ name: string; line: string }> {
  if (doesEnterpriseMcpConfigExist() || isRestrictedToExtensionsOnly('mcp') || untrustedWorkspaceHeadless()) return []
  const local = getLocalMcpConfigs().servers
  const { allowed } = filterMcpServersByPolicy(getProjectMcpConfigs().servers)
  const lines: Array<{ name: string; line: string }> = []
  for (const [name, config] of Object.entries(allowed)) {
    if (name in local) continue
    const line = mcpServerSkippedForApprovalLine(name, config)
    if (line !== null) lines.push({ name, line })
  }
  return lines
}

export const PROJECT_MCP_FILE_SPELLING = `${MERCURY_PROJECT_DIR}/${PROJECT_MCP_FILE}`

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
  if (!isSettingSourceEnabled('userSettings')) return { servers: {}, errors: [], notices: [] }
  const servers = getGlobalConfig().mcpServers
  if (!servers) return { servers: {}, errors: [], notices: [] }
  return flat(
    parseMcpConfig({ configObject: { mcpServers: servers }, expandVars: true, scope: 'user' }),
  )
}

function getLocalMcpConfigs(): ScopeRead {
  if (!isSettingSourceEnabled('localSettings')) return { servers: {}, errors: [], notices: [] }
  const servers = getCurrentProjectConfig().mcpServers
  if (!servers) return { servers: {}, errors: [], notices: [] }
  return flat(
    parseMcpConfig({ configObject: { mcpServers: servers }, expandVars: true, scope: 'local' }),
  )
}

export function getMcpConfigsByScope(scope: 'project' | 'user' | 'local' | 'enterprise'): {
  servers: Record<string, ScopedMcpServerConfig>
  errors: McpConfigError[]
  notices: string[]
} {
  return scope === 'project'
    ? getProjectMcpConfigs()
    : scope === 'user'
      ? getUserMcpConfigs()
      : scope === 'local'
        ? getLocalMcpConfigs()
        : getEnterpriseMcpConfigs()
}

type PolicyEntry = { serverName: string } | { serverCommand: string[] } | { serverUrl: string }

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

function getDenyList(): PolicyEntry[] {
  const entries: PolicyEntry[] = []
  for (const source of SETTINGS_SOURCES) {
    const denied = getSettingsForSource(source)?.kit?.deny
    if (Array.isArray(denied)) entries.push(...(denied as PolicyEntry[]))
  }
  return entries
}

export function shouldAllowManagedMcpServersOnly(): boolean {
  return getSettingsForSource('policySettings')?.kit?.managedOnly === true
}

function getAllowList(): PolicyEntry[] | undefined {
  if (shouldAllowManagedMcpServersOnly()) {
    return (getSettingsForSource('policySettings')?.kit?.permit ?? []) as PolicyEntry[]
  }
  const allowed = getInitialSettings()?.kit?.permit
  return allowed === undefined ? undefined : (allowed as PolicyEntry[])
}

function isServerDenied(serverName: string, config?: McpServerConfig): boolean {
  return getDenyList().some(entry => entryMatches(entry, serverName, config))
}

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

export function filterMcpServersByPolicy<T>(
  configs: Record<string, T>,
): { allowed: Record<string, T>; blocked: string[] } {
  const allowed: Record<string, T> = {}
  const blocked: string[] = []
  for (const [name, config] of Object.entries(configs)) {
    if ((config as { type?: string } | undefined)?.type === 'host') {
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

let enterpriseMcpConfigExists: boolean | null = null

export function doesEnterpriseMcpConfigExist(): boolean {
  if (enterpriseMcpConfigExists === null) {
    const read = readConfigFile(getEnterpriseMcpFilePath())
    enterpriseMcpConfigExists =
      read.kind === 'content' &&
      parseMcpConfig({ configObject: read.value, expandVars: false, scope: 'enterprise' }).config !== null
  }
  return enterpriseMcpConfigExists
}

export function areMcpConfigsAllowedWithEnterpriseMcpConfig(
  configs: Record<string, McpServerConfig | ScopedMcpServerConfig>,
): boolean {
  return Object.entries(configs).every(
    ([name, config]) => (config as { type?: string }).type === 'host' && name === 'mercury-editor',
  )
}

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

export function dedupAnthropicConnectors(
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

export type McpResolutionNotice = {
  kind: 'suppressed-duplicate'

  server: string
  extensionName: string
  duplicateOf: string
  message: string
} | {
  kind: 'document-bounded'
  message: string
}

function getExtensionProvidedMcpServers(): Record<string, ScopedMcpServerConfig> {
  try {
    return getExtensionMcpServers()
  } catch (error) {
    logForDebugging(`MCP extension server loading failed: ${String(error)}`)
    return {}
  }
}

function documentBoundNotices(...reads: ScopeRead[]): McpResolutionNotice[] {
  return reads.flatMap(read => read.notices.map(message => ({ kind: 'document-bounded' as const, message })))
}

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

export async function getMercuryMcpConfigs(
  dynamicServers?: Record<string, ScopedMcpServerConfig>,
  extraDedupTargets?: Promise<Record<string, ScopedMcpServerConfig>>,
): Promise<{ servers: Record<string, ScopedMcpServerConfig>; errors: McpResolutionNotice[] }> {

  if (doesEnterpriseMcpConfigExist()) {
    const enterprise = getEnterpriseMcpConfigs()
    const { allowed } = filterMcpServersByPolicy(enterprise.servers)
    return { servers: allowed, errors: documentBoundNotices(enterprise) }
  }

  const emptyRead: ScopeRead = { servers: {}, errors: [], notices: [] }
  const mcpLocked = isRestrictedToExtensionsOnly('mcp')

  const projectUntrusted = untrustedWorkspaceHeadless()
  if (projectUntrusted) {
    logForDebugging(
      'mcp: untrusted workspace on a non-interactive road — project MCP servers are not loaded (boot interactively once here to trust this directory)',
    )
  }
  const user = mcpLocked ? emptyRead : getUserMcpConfigs()
  const project = mcpLocked || projectUntrusted ? emptyRead : getProjectMcpConfigs()
  const local = mcpLocked ? emptyRead : getLocalMcpConfigs()

  const extensionServers = getExtensionProvidedMcpServers()

  const approvedProject: Record<string, ScopedMcpServerConfig> = {}
  for (const [name, config] of Object.entries(project.servers)) {
    if (getProjectMcpServerStatus(name, config) === 'approved') approvedProject[name] = config
  }

  const extraTargets = extraDedupTargets === undefined ? {} : await extraDedupTargets

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

  const merged: Record<string, ScopedMcpServerConfig> = {
    ...dedupedExtensions,
    ...user.servers,
    ...approvedProject,
    ...local.servers,
  }

  const { allowed } = filterMcpServersByPolicy(merged)
  return { servers: allowed, errors: [...documentBoundNotices(user, project, local), ...suppressionNotices(suppressed)] }
}

export async function getAllMcpConfigs(): Promise<{
  servers: Record<string, ScopedMcpServerConfig>
  errors: McpResolutionNotice[]
}> {
  if (doesEnterpriseMcpConfigExist()) {
    return getMercuryMcpConfigs()
  }
  const connectorFetch = fetchAnthropicConnectorsIfEligible()
  const resolved = await getMercuryMcpConfigs()
  const connectors = await connectorFetch
  if (Object.keys(connectors).length === 0) return resolved
  const { allowed: allowedConnectors } = filterMcpServersByPolicy(connectors)
  const { servers: dedupedConnectors } = dedupAnthropicConnectors(
    allowedConnectors,
    resolved.servers,
  )
  return {
    servers: { ...dedupedConnectors, ...resolved.servers },
    errors: resolved.errors,
  }
}

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

function stripScope(config: McpServerConfig | ScopedMcpServerConfig): McpServerConfig {
  const { scope: _scope, ...rest } = config as ScopedMcpServerConfig
  return rest as McpServerConfig
}

type ProjectMcpDocument = Record<string, unknown> & { mcpServers: Record<string, unknown> }

function readProjectMcpDocument(mcpJsonPath: string): ProjectMcpDocument {
  const read = readConfigFile(mcpJsonPath)
  if (read.kind === 'absent') return { mcpServers: {} }
  if (read.kind === 'unreadable') throw new Error(`Failed to read MCP configuration file: ${read.message}`)
  if (read.kind === 'invalid-json') throw new Error(`MCP configuration file is not valid JSON: ${read.message}`)
  const value = read.value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${mcpJsonPath} ${SCHEMA_MISMATCH}`)
  const servers = (value as { mcpServers?: unknown }).mcpServers
  if (servers !== undefined && (servers === null || typeof servers !== 'object' || Array.isArray(servers))) throw new Error(`${mcpJsonPath} ${SCHEMA_MISMATCH}`)
  return { ...(value as Record<string, unknown>), mcpServers: { ...((servers ?? {}) as Record<string, unknown>) } }
}

async function writeProjectMcpFile(document: ProjectMcpDocument): Promise<void> {
  const mcpJsonPath = projectMcpFilePath(getCwd())
  const fs = getFsImplementation()
  let mode = 0o644
  try {
    if (fs.existsSync(mcpJsonPath)) {
      mode = fs.statSync(mcpJsonPath).mode & 0o777
    }
  } catch {
  }
  try {
    await durableAtomicPublish(mcpJsonPath, `${JSON.stringify(document, null, 2)}\n`, { mode })
  } catch (error) {
    throw new Error(
      `Failed to write to ${mcpJsonPath}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

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

  const mercury = await import('./mercuryServer.js')
  if (mercury.isMercuryServerEnabled() && mercury.isMercuryServer(name)) {
    throw new Error(
      `"${name}" is reserved for Mercury's in-process MCP server (disable with MERCURY_COORDINATION_MCP=0)`,
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
  const refusal = mcpStdioCommandRefusal(name, effective) ?? mcpStdioCommandRefusal(name, expandServerConfig(effective).config)
  if (refusal !== null) throw new Error(refusal)

  if (isServerDenied(name, effective)) {
    throw new Error(`MCP server "${name}" is explicitly blocked by enterprise policy`)
  }
  if (!isServerAllowed(name, effective)) {
    throw new Error(`MCP server "${name}" is not allowed by enterprise policy`)
  }

  switch (scope) {
    case 'project': {

      const mcpJsonPath = lockedProjectMcpFile()
      const { runExclusiveOnFileSync } = await import('../../utils/config/globalConfig.js')
      await runExclusiveOnFileSync(mcpJsonPath, async () => {
        const document = readProjectMcpDocument(mcpJsonPath)
        if (name in document.mcpServers) {
          throw new Error(`MCP server "${name}" already exists in ${mcpJsonPath}`)
        }
        await writeProjectMcpFile({ ...document, mcpServers: { ...document.mcpServers, [name]: stripScope(effective) } })
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

export async function removeMcpConfig(name: string, scope: ConfigScope): Promise<void> {
  switch (scope) {
    case 'project': {

      const mcpJsonPath = projectMcpFilePath(getCwd())
      if (!getFsImplementation().existsSync(mcpJsonPath)) {
        throw new Error(`MCP server "${name}" does not exist in ${mcpJsonPath}`)
      }
      const { runExclusiveOnFileSync } = await import('../../utils/config/globalConfig.js')
      await runExclusiveOnFileSync(mcpJsonPath, async () => {
        const document = readProjectMcpDocument(mcpJsonPath)
        if (!(name in document.mcpServers)) {
          throw new Error(`MCP server "${name}" does not exist in ${mcpJsonPath}`)
        }
        const { [name]: _removed, ...rest } = document.mcpServers
        await writeProjectMcpFile({ ...document, mcpServers: rest })
      })
      break
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
      break
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
      break
    }
    default:
      throw new Error(`Cannot remove an MCP server from the ${String(scope)} scope`)
  }
  const { forgetMcpNeedsAuth } = await import('./client.js')
  await forgetMcpNeedsAuth(name)
}

export function isMcpServerDisabled(name: string): boolean {
  return isMcpServerDisabledIn(getCurrentProjectConfig(), name)
}

export function setMcpServerEnabled(name: string, enabled: boolean): void {
  saveCurrentProjectConfig(current => withMcpServerEnabled(current, name, enabled))
}
