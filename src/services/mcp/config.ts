import { dirname, resolve } from 'node:path'

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
import { MERCURY_PROJECT_DIR } from '../../utils/projectConfig.js'
import { durableAtomicPublish, DurablePublishError } from '../../substrate/durablePublish.js'
import { AtomicWriteRefusal } from '../../utils/file.js'
import { isSettingSourceAllowedAtLaunch } from '../../utils/settings/constants.js'
import { isRestrictedToExtensionsOnly } from '../../utils/settings/extensionOnlyPolicy.js'
import { getInitialSettings, getSettingsForSource } from '../../utils/settings/settings.js'
import { settingsFaultLine } from '../../utils/settings/validation.js'
import { getExtensionMcpServers } from '../../extensions/load/servers.js'
import { parseServerRuntimeName } from '../../extensions/manifest.js'
import { isMcpServerDisabledIn, withMcpServerEnabled } from './disabledRecord.js'
import type { ConfigScope, McpServerConfig, ScopedMcpServerConfig } from '../../utils/mcp/types.js'
import { getProjectMcpServerStatus, mcpVariableCarriesCode } from './utils.js'
import { PROJECT_MCP_FILE, getEnterpriseMcpFilePath, projectMcpFilePath } from './configPaths.js'
import { passedOver } from '../../utils/passedOver.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'


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

const SCHEMA_MISMATCH: Unbuilt = unbuilt('src/services/mcp/config.ts:189')
export const MCP_SERVERS_MAX_PER_DOCUMENT: Unbuilt = unbuilt('src/services/mcp/config.ts:192')

export function parseMcpConfig(arg0: {
  configObject: unknown
  expandVars: boolean
  scope: ConfigScope
  filePath?: string
}): ParseResult {
  return notBuilt('src/services/mcp/config.ts:194')
}

export function parseMcpConfigFromFilePath(arg0: {
  filePath: string
  expandVars: boolean
  scope: ConfigScope
}): ParseResult {
  return notBuilt('src/services/mcp/config.ts:270')
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

export { PROJECT_MCP_FILE, getEnterpriseMcpFilePath, projectMcpFilePath }

function lockedProjectMcpFile(): string {
  const path = projectMcpFilePath(getCwd())
  getFsImplementation().mkdirSync(dirname(path))
  return path
}

export function getProjectMcpConfigs(): ScopeRead {
  if (!isSettingSourceAllowedAtLaunch('projectSettings')) return { servers: {}, errors: [], notices: [] }
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
  if (!isSettingSourceAllowedAtLaunch('projectSettings')) return { servers: {}, errors: [], notices: [] }
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
    if (Object.hasOwn(local, name)) continue
    const line = mcpServerSkippedForApprovalLine(name, config)
    if (line !== null) lines.push({ name, line })
  }
  return lines
}

export const PROJECT_MCP_FILE_SPELLING = `${MERCURY_PROJECT_DIR}/${PROJECT_MCP_FILE}`

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
  if (!isSettingSourceAllowedAtLaunch('userSettings')) return { servers: {}, errors: [], notices: [] }
  const servers = getGlobalConfig().mcpServers
  if (!servers) return { servers: {}, errors: [], notices: [] }
  return flat(
    parseMcpConfig({ configObject: { mcpServers: servers }, expandVars: true, scope: 'user' }),
  )
}

function getLocalMcpConfigs(): ScopeRead {
  if (!isSettingSourceAllowedAtLaunch('localSettings')) return { servers: {}, errors: [], notices: [] }
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
  } catch (error) {
    passedOver(error)
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
  return notBuilt('src/services/mcp/config.ts:643')
}

export function dedupAnthropicConnectors(
  connectorServers: Record<string, ScopedMcpServerConfig>,
  manualServers: Record<string, McpServerConfig | ScopedMcpServerConfig>,
): DedupResult {
  return notBuilt('src/services/mcp/config.ts:676')
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
} | {
  kind: 'config-fault'
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

function configFaultNotices(...reads: ScopeRead[]): McpResolutionNotice[] {
  return reads.flatMap(read =>
    read.errors.map(error => ({
      kind: 'config-fault' as const,
      message: settingsFaultLine({
        path: error.path,
        message: error.message,
        ...(error.severity === 'warning' ? { severity: 'warning' as const } : {}),
      }),
    })),
  )
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
    return { servers: allowed, errors: [...configFaultNotices(enterprise), ...documentBoundNotices(enterprise)] }
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
  return {
    servers: allowed,
    errors: [...configFaultNotices(user, project, local), ...documentBoundNotices(user, project, local), ...suppressionNotices(suppressed)],
  }
}

export async function getAllMcpConfigs(): Promise<{
  servers: Record<string, ScopedMcpServerConfig>
  errors: McpResolutionNotice[]
}> {
  return notBuilt('src/services/mcp/config.ts:815')
}

export function getMcpConfigByName(name: string): ScopedMcpServerConfig | null {
  const enterprise = getEnterpriseMcpConfigs().servers
  if (Object.hasOwn(enterprise, name)) return enterprise[name] ?? null
  if (isRestrictedToExtensionsOnly('mcp')) return null
  const local = getLocalMcpConfigs().servers
  if (Object.hasOwn(local, name)) return local[name] ?? null
  const project = getProjectMcpConfigs().servers
  if (Object.hasOwn(project, name)) return project[name] ?? null
  const user = getUserMcpConfigs().servers
  if (Object.hasOwn(user, name)) return user[name] ?? null
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

function heldWriteFailure(error: unknown): { path: string; code: string } | null {
  if (error instanceof DurablePublishError && error.phase === 'rename') return { path: error.targetPath, code: error.fsCode ?? 'write error' }
  if (error instanceof AtomicWriteRefusal && error.phase === 'rename') return { path: error.targetPath, code: error.code ?? 'write error' }
  return null
}

async function writeProjectMcpFile(document: ProjectMcpDocument, action = 'update MCP configuration'): Promise<void> {
  const mcpJsonPath = projectMcpFilePath(getCwd())
  const fs = getFsImplementation()
  let mode = 0o644
  try {
    if (fs.existsSync(mcpJsonPath)) {
      mode = fs.statSync(mcpJsonPath).mode & 0o777
    }
  } catch (error) {
    passedOver(error)
  }
  try {
    await durableAtomicPublish(mcpJsonPath, `${JSON.stringify(document, null, 2)}\n`, { mode })
  } catch (error) {
    const held = heldWriteFailure(error)
    if (held !== null) {
      logForDebugging(`Failed to write to ${mcpJsonPath}: ${error instanceof Error ? error.message : String(error)}`, { level: 'error' })
      throw new Error(
        `Could not ${action}: ${held.path} could not be written (${held.code}); nothing was written. Close what holds the file, then try again.`,
      )
    }
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
  return notBuilt('src/services/mcp/config.ts:903')
}

export async function removeMcpConfig(name: string, scope: ConfigScope, beforeRemoval?: () => void): Promise<void> {
  switch (scope) {
    case 'project': {
      const mcpJsonPath = projectMcpFilePath(getCwd())
      if (!getFsImplementation().existsSync(mcpJsonPath)) {
        throw new Error(`MCP server "${name}" does not exist in ${mcpJsonPath}`)
      }
      const { runExclusiveOnFileSync } = await import('../../utils/config/globalConfig.js')
      await runExclusiveOnFileSync(mcpJsonPath, async () => {
        const document = readProjectMcpDocument(mcpJsonPath)
        if (!Object.hasOwn(document.mcpServers, name)) {
          throw new Error(`MCP server "${name}" does not exist in ${mcpJsonPath}`)
        }
        beforeRemoval?.()
        const { [name]: _removed, ...rest } = document.mcpServers
        await writeProjectMcpFile({ ...document, mcpServers: rest })
      })
      break
    }
    case 'user': {
      const servers = getGlobalConfig().mcpServers ?? {}
      if (!Object.hasOwn(servers, name)) {
        throw new Error(`MCP server "${name}" is not user-scoped`)
      }
      beforeRemoval?.()
      saveGlobalConfig(current => {
        const { [name]: _removed, ...rest } = current.mcpServers ?? {}
        return { ...current, mcpServers: rest }
      })
      break
    }
    case 'local': {
      const servers = getCurrentProjectConfig().mcpServers ?? {}
      if (!Object.hasOwn(servers, name)) {
        throw new Error(`MCP server "${name}" is not in the project-local config`)
      }
      beforeRemoval?.()
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
