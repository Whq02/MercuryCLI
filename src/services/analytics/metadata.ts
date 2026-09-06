import { memoize } from 'lodash-es'

import {
  getIsNonInteractiveSession,
  getParentSessionId,
  getSessionId,
} from '../../bootstrap/state.js'
import { MERCURY_VERSION } from '../../constants/product.js'
import { getAgentContext, isTeammateAgentContext } from '../../utils/agentContext.js'
import { getSubscriptionType } from '../../utils/auth.js'
import { getModelBetas } from '../../utils/betas.js'
import { env, getHostPlatformForAnalytics } from '../../utils/env.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getRepoRemoteHash } from '../../utils/git.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { detectVcs, getLinuxDistroInfo, getWslVersion } from '../../utils/platform.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { isTeammate } from '../../utils/teammate.js'
import type { CoreUserData } from '../../utils/user.js'


export function sanitizeToolNameForAnalytics(toolName: string): string {
  return toolName.startsWith('mcp__') ? 'mcp_tool' : toolName
}

const MAX_EXTENSION_LENGTH = 10

export function getFileExtensionForAnalytics(filePath: string): string | undefined {
  const dot = filePath.lastIndexOf('.')
  if (dot === -1) return undefined
  const extension = filePath.slice(dot + 1).toLowerCase()
  if (extension === '') return undefined
  return extension.length > MAX_EXTENSION_LENGTH ? 'other' : extension
}


export function extractMcpToolDetails(name: string): { serverName: string; toolName: string } | undefined {
  if (!name.startsWith('mcp__')) return undefined
  const parts = name.split('__')
  if (parts.length < 3) return undefined
  const serverName = parts[1]
  const toolName = parts.slice(2).join('__')
  if (!serverName || !toolName) return undefined
  return { serverName, toolName }
}

export function extractSkillName(toolName: string, input: unknown): string | undefined {
  if (toolName !== 'Skill') return undefined
  const skill = (input as { skill?: unknown } | null)?.skill
  return typeof skill === 'string' ? skill : undefined
}

const FIRST_PARTY_MCP_SERVERS: ReadonlySet<string> = new Set()

export function isToolDetailsLoggingEnabled(server: {
  name?: string
  transport?: string
}): boolean {
  if (server.name !== undefined && FIRST_PARTY_MCP_SERVERS.has(server.name)) return true
  if (process.env.MERCURY_ENTRYPOINT === 'local-agent') return true
  if (server.transport === 'claudeai-proxy') return true
  return false
}

export function isAnalyticsToolDetailsLoggingEnabled(): boolean {
  return isEnvTruthy(process.env.OTEL_LOG_TOOL_DETAILS)
}

export function mcpToolDetailsForAnalytics(
  toolName: string,
  server: { name?: string; transport?: string },
): { serverName: string; toolName: string } | undefined {
  if (!isToolDetailsLoggingEnabled(server)) return undefined
  return extractMcpToolDetails(toolName)
}

const TOOL_INPUT_STRING_TRUNCATE_AT = 512
const TOOL_INPUT_STRING_KEEP = 128
const TOOL_INPUT_MAX_ENTRIES = 20
const TOOL_INPUT_MAX_DEPTH = 2
const TOOL_INPUT_JSON_CAP = 4096

function serializeValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    if (value.length > TOOL_INPUT_STRING_TRUNCATE_AT) {
      return `${value.slice(0, TOOL_INPUT_STRING_KEEP)}… [truncated, ${value.length} chars]`
    }
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return value
  }
  if (depth >= TOOL_INPUT_MAX_DEPTH) return '[nested]'
  if (Array.isArray(value)) {
    const kept = value.slice(0, TOOL_INPUT_MAX_ENTRIES).map(entry => serializeValue(entry, depth + 1))
    if (value.length > TOOL_INPUT_MAX_ENTRIES) {
      kept.push(`[+${value.length - TOOL_INPUT_MAX_ENTRIES} more]`)
    }
    return kept
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    const entries = Object.entries(value).filter(([key]) => !key.startsWith('_'))
    let count = 0
    for (const [key, inner] of entries) {
      if (count >= TOOL_INPUT_MAX_ENTRIES) {
        out['[overflow]'] = `[+${entries.length - TOOL_INPUT_MAX_ENTRIES} more]`
        break
      }
      out[key] = serializeValue(inner, depth + 1)
      count++
    }
    return out
  }
  return String(value)
}

export function extractToolInputForTelemetry(input: unknown): string | undefined {
  if (!isAnalyticsToolDetailsLoggingEnabled()) return undefined
  const json = jsonStringify(serializeValue(input, 0)) ?? ''
  if (json.length > TOOL_INPUT_JSON_CAP) {
    return `${json.slice(0, TOOL_INPUT_JSON_CAP)}… [truncated]`
  }
  return json
}

const FILE_TOUCHING_COMMANDS: ReadonlySet<string> = new Set([
  'rm', 'mv', 'cp', 'touch', 'mkdir', 'chmod', 'chown', 'cat', 'head', 'tail',
  'sort', 'stat', 'diff', 'wc', 'grep', 'rg', 'sed',
])

export function getFileExtensionsFromBashCommand(
  command: string,
  simulatedEditPath?: string,
): string | undefined {
  if (!command.includes('.') && simulatedEditPath === undefined) return undefined
  const found: string[] = []
  if (simulatedEditPath !== undefined) {
    const extension = getFileExtensionForAnalytics(simulatedEditPath)
    if (extension !== undefined) found.push(extension)
  }
  for (const subCommand of command.split(/&&|\|\||;|\|/)) {
    const tokens = subCommand.trim().split(/\s+/)
    if (tokens.length < 2) continue
    const lead = tokens[0] as string
    const leadName = lead.slice(lead.lastIndexOf('/') + 1)
    if (!FILE_TOUCHING_COMMANDS.has(leadName)) continue
    for (const argument of tokens.slice(1)) {
      if (argument.startsWith('-')) continue
      const extension = getFileExtensionForAnalytics(argument)
      if (extension !== undefined) found.push(extension)
    }
  }
  const unique = [...new Set(found)]
  return unique.length > 0 ? unique.join(',') : undefined
}


export type EnvContext = {
  platform: string
  rawPlatform: string
  arch: string
  nodeVersion: string
  terminal: string | null
  packageManagers: string
  runtimes: string
  isRunningWithBun: boolean
  isCi: boolean
  isLocalAgent: boolean
  isConductor: boolean
  tags?: string
  isAuthenticated: boolean
  version: string
  baseVersion?: string
  buildTime?: string
  deploymentEnvironment?: string
  wslVersion?: string
  linuxDistroId?: string
  linuxDistroVersion?: string
  linuxKernel?: string
  versionControlSystems?: string
  coworkerType?: string
  remoteEnvironmentType?: string
  containerId?: string
  remoteSessionId?: string
}

const getBaseVersion = memoize((): string | undefined => {
  const match = /^(\d+\.\d+\.\d+)(?:-[a-z]+)?/.exec(MERCURY_VERSION)
  return match ? match[0] : undefined
})

const buildEnvContext = memoize(async (): Promise<EnvContext> => {
  const [packageManagers, runtimes, distro, vcs] = await Promise.all([
    env.getPackageManagers(),
    env.getRuntimes(),
    getLinuxDistroInfo(),
    detectVcs(),
  ])
  const wslVersion = getWslVersion()
  const distroRecord = distro as { id?: string; version?: string; kernel?: string } | null
  return {
    platform: getHostPlatformForAnalytics(),
    rawPlatform: process.platform,
    arch: env.arch,
    nodeVersion: env.nodeVersion,
    terminal: env.terminal,
    packageManagers: packageManagers.join(','),
    runtimes: runtimes.join(','),
    isRunningWithBun: env.isRunningWithBun(),
    isCi: env.isCI,
    isLocalAgent: process.env.MERCURY_ENTRYPOINT === 'local-agent',
    isConductor: env.isConductor(),
    isAuthenticated: true,
    version: MERCURY_VERSION,
    ...(getBaseVersion() !== undefined ? { baseVersion: getBaseVersion() } : {}),
    deploymentEnvironment: env.detectDeploymentEnvironment(),
    ...(wslVersion ? { wslVersion: String(wslVersion) } : {}),
    ...(distroRecord?.id ? { linuxDistroId: distroRecord.id } : {}),
    ...(distroRecord?.version ? { linuxDistroVersion: distroRecord.version } : {}),
    ...(distroRecord?.kernel ? { linuxKernel: distroRecord.kernel } : {}),
    ...(vcs && vcs.length > 0 ? { versionControlSystems: vcs.join(',') } : {}),
  }
})

export type ProcessMetrics = {
  uptime: number
  rss: number
  heapTotal: number
  heapUsed: number
  external: number
  arrayBuffers: number
  constrainedMemory: number
  cpuUsage: { user: number; system: number }
  cpuPercent?: number
}

let previousCpu: { usage: NodeJS.CpuUsage; at: number } | null = null

function collectProcessMetrics(): ProcessMetrics | undefined {
  try {
    const memory = process.memoryUsage()
    const cpu = process.cpuUsage()
    const now = Date.now()
    let cpuPercent: number | undefined
    if (previousCpu !== null) {
      const wallMs = now - previousCpu.at
      if (wallMs > 0) {
        const usedMicros = cpu.user - previousCpu.usage.user + (cpu.system - previousCpu.usage.system)
        cpuPercent = (usedMicros / 1000 / wallMs) * 100
      }
    }
    previousCpu = { usage: cpu, at: now }
    return {
      uptime: process.uptime(),
      rss: memory.rss,
      heapTotal: memory.heapTotal,
      heapUsed: memory.heapUsed,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
      constrainedMemory: Number(process.constrainedMemory?.() ?? 0),
      cpuUsage: { user: cpu.user, system: cpu.system },
      ...(cpuPercent !== undefined ? { cpuPercent } : {}),
    }
  } catch {
    return undefined
  }
}

export type EventMetadata = {
  model: string
  sessionId: string
  userType: 'external'
  betaHeaders?: string
  env: EnvContext
  entrypoint?: string
  agentSdkVersion?: string
  isInteractive: string
  clientType: string
  processMetrics?: ProcessMetrics
  agentId?: string
  parentSessionId?: string
  agentType?: string
  teamName?: string
  subscriptionType?: string
  repoRemoteHash?: string
  assistantMode?: string
  skillMode?: string
  observerMode?: string
}

export type EnrichMetadataOptions = { model?: unknown }

function agentIdentification(): Partial<EventMetadata> {
  const context = getAgentContext()
  if (context) {
    return {
      agentId: (context as { agentId?: string }).agentId,
      parentSessionId: (context as { parentSessionId?: string }).parentSessionId,
      agentType: (context as { agentType?: string }).agentType,
      ...(isTeammateAgentContext(context)
        ? { teamName: (context as { teamName?: string }).teamName }
        : {}),
    }
  }
  const envAgentId = process.env.MERCURY_AGENT_ID
  if (envAgentId) {
    return { agentId: envAgentId, agentType: isTeammate() ? 'teammate' : 'standalone' }
  }
  const parent = getParentSessionId()
  if (parent) return { parentSessionId: parent }
  return {}
}

export async function getEventMetadata(options?: EnrichMetadataOptions): Promise<EventMetadata> {
  const [envContext, repoHash] = await Promise.all([buildEnvContext(), getRepoRemoteHash()])
  const betas = getModelBetas(getMainLoopModel())
  const subscription = getSubscriptionType()
  return {
    model: options?.model !== undefined ? String(options.model) : getMainLoopModel(),
    sessionId: getSessionId(),
    userType: 'external',
    ...(betas.length > 0 ? { betaHeaders: betas.join(',') } : {}),
    env: envContext,
    ...(process.env.MERCURY_ENTRYPOINT ? { entrypoint: process.env.MERCURY_ENTRYPOINT } : {}),
    ...(process.env.MERCURY_SDK_VERSION
      ? { agentSdkVersion: process.env.MERCURY_SDK_VERSION }
      : {}),
    isInteractive: String(!getIsNonInteractiveSession()),
    clientType: 'cli',
    ...(collectProcessMetrics() !== undefined ? { processMetrics: collectProcessMetrics() } : {}),
    ...agentIdentification(),
    ...(subscription ? { subscriptionType: subscription } : {}),
    ...(repoHash ? { repoRemoteHash: repoHash } : {}),
  }
}


export type EnvironmentMetadata = Record<string, unknown>

export type PublicApiAuth = {
  account_uuid?: string
  organization_uuid?: string
}

export type FirstPartyEventLoggingCoreMetadata = Record<string, unknown>

export type FirstPartyEventLoggingMetadata = {
  env: EnvironmentMetadata
  process_metrics?: string
  auth?: PublicApiAuth
  core: FirstPartyEventLoggingCoreMetadata
  additional: Record<string, unknown>
}

export function to1PEventFormat(
  metadata: EventMetadata,
  userData: CoreUserData,
  extras?: Record<string, unknown>,
): FirstPartyEventLoggingMetadata {
  const context = metadata.env
  const envRecord: EnvironmentMetadata = {
    platform: context.platform,
    raw_platform: context.rawPlatform,
    arch: context.arch,
    node_version: context.nodeVersion,
    terminal: context.terminal ?? 'unknown',
    package_managers: context.packageManagers,
    runtimes: context.runtimes,
    is_running_with_bun: context.isRunningWithBun,
    is_ci: context.isCi,
    is_local_agent: context.isLocalAgent,
    is_conductor: context.isConductor,
    is_authenticated: context.isAuthenticated,
    version: context.version,
  }
  if (context.tags) {
    envRecord.tags = context.tags
      .split(',')
      .map(tag => tag.trim())
      .filter(tag => tag !== '')
  }
  for (const [snake, value] of [
    ['base_version', context.baseVersion],
    ['build_time', context.buildTime],
    ['deployment_environment', context.deploymentEnvironment],
    ['wsl_version', context.wslVersion],
    ['linux_distro_id', context.linuxDistroId],
    ['linux_distro_version', context.linuxDistroVersion],
    ['linux_kernel', context.linuxKernel],
    ['version_control_systems', context.versionControlSystems],
  ] as const) {
    if (value) envRecord[snake] = value
  }

  const auth: PublicApiAuth = {}
  if (userData.accountUuid) auth.account_uuid = userData.accountUuid
  if (userData.organizationUuid) auth.organization_uuid = userData.organizationUuid

  const core: FirstPartyEventLoggingCoreMetadata = {
    model: metadata.model,
    session_id: metadata.sessionId,
    user_type: metadata.userType,
    is_interactive: metadata.isInteractive === 'true',
    client_type: metadata.clientType,
  }
  for (const [snake, value] of [
    ['beta_headers', metadata.betaHeaders],
    ['entrypoint', metadata.entrypoint],
    ['agent_sdk_version', metadata.agentSdkVersion],
    ['agent_id', metadata.agentId],
    ['parent_session_id', metadata.parentSessionId],
    ['agent_type', metadata.agentType],
    ['team_name', metadata.teamName],
    ['subscription_type', metadata.subscriptionType],
  ] as const) {
    if (value) core[snake] = value
  }

  const additional: Record<string, unknown> = { ...(extras ?? {}) }
  if (metadata.repoRemoteHash) additional.repo_remote_hash = metadata.repoRemoteHash

  return {
    env: envRecord,
    ...(metadata.processMetrics !== undefined
      ? { process_metrics: Buffer.from(jsonStringify(metadata.processMetrics) ?? '').toString('base64') }
      : {}),
    ...(auth.account_uuid || auth.organization_uuid ? { auth } : {}),
    core,
    additional,
  }
}
