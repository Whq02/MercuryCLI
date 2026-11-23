import { existsSync } from 'node:fs'
import { consumeSessionKitPin } from '../../integrations/mcp/sessionKitPin.js'
import {
  areMcpConfigsAllowedWithEnterpriseMcpConfig,
  doesEnterpriseMcpConfigExist,
  filterMcpServersByPolicy,
  getMercuryMcpConfigs,
  parseMcpConfig,
  parseMcpConfigFromFilePath,
} from '../../integrations/mcp/serverConfigs.js'
import { isMercuryServerEnabled, mercuryServerConfig, MERCURY_SERVER_NAME } from '../../integrations/mcp/mercuryServer.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { isBareMode } from '../../platform/environment/envUtils.js'
import type { ScopedMcpServerConfig } from '../../integrations/mcp-shapes/mcpServerRecords.js'
import chalk from 'chalk'
import { failCli, writeErr, type RootOptions } from './cli.js'

export function resolveMcpConfigs(opts: RootOptions) {
  consumeSessionKitPin()
  const dynamicConfigResult = parseDynamicMcpConfigs((opts.mcp as string[] | undefined) ?? [])
  if (dynamicConfigResult.errors.length > 0) {
    logForDebugging(
      `${dynamicConfigResult.errors.length} MCP config error(s): ${dynamicConfigResult.errors.join('; ')}`,
    )
    failCli(`Invalid MCP configuration:\n${dynamicConfigResult.errors.join('\n')}`)
  }
  let dynamicMcpConfig = dynamicConfigResult.servers

  if (isMercuryServerEnabled() && Object.keys(dynamicMcpConfig).includes(MERCURY_SERVER_NAME)) {
    writeErr(
      `The MCP server name '${MERCURY_SERVER_NAME}' is reserved while Mercury's in-process MCP server is enabled (MERCURY_COORDINATION_MCP).`,
    )
    process.exit(1)
  }

  const policyFiltered = filterMcpServersByPolicy(dynamicMcpConfig)
  const blockedNames = Object.keys(dynamicMcpConfig).filter(name => !(name in policyFiltered.allowed))
  if (blockedNames.length > 0) {
    writeErr(
      chalk.yellow(
        `${blockedNames.length === 1 ? 'MCP server' : 'MCP servers'} blocked by managed policy: ${blockedNames.join(', ')}`,
      ),
    )
  }
  dynamicMcpConfig = policyFiltered.allowed as typeof dynamicMcpConfig

  if (doesEnterpriseMcpConfigExist()) {
    if (opts.onlyMcp) failCli('--only-mcp is not available when an enterprise MCP configuration exists', 1)
    const allowedCheck = areMcpConfigsAllowedWithEnterpriseMcpConfig(dynamicMcpConfig)
    if (allowedCheck !== true) {
      failCli('Dynamic MCP servers are not allowed when an enterprise MCP configuration exists', 1)
    }
  }
  if (isMercuryServerEnabled()) {
    dynamicMcpConfig = {
      ...dynamicMcpConfig,
      ...Object.fromEntries(
        Object.entries(mercuryServerConfig()).map(([name, config]) => [
          name,
          { ...config, scope: 'dynamic' as const },
        ]),
      ),
    }
  }
  const strictOrBare = Boolean(opts.onlyMcp) || isBareMode()
  const mcpResolutionStartedAt = Date.now()
  const discoveredMcpPromise: Promise<Record<string, ScopedMcpServerConfig>> = strictOrBare
    ? Promise.resolve({})
    : getMercuryMcpConfigs(dynamicMcpConfig).then(resolved => resolved.servers)
  const mcpConfigPromise = discoveredMcpPromise.then(discovered => {
    const regular: Record<string, ScopedMcpServerConfig> = Object.assign(Object.create(null), discovered, dynamicMcpConfig) as Record<string, ScopedMcpServerConfig>
    logForDebugging(`MCP config resolution took ${Date.now() - mcpResolutionStartedAt}ms`)
    return regular
  })
  const regularDynamicMcpConfig: Record<string, ScopedMcpServerConfig> = dynamicMcpConfig
  return { mcpConfigPromise, regularDynamicMcpConfig }
}

function parseDynamicMcpConfigs(items: string[]): {
  servers: Record<string, ScopedMcpServerConfig>
  errors: string[]
} {
  const servers: Record<string, ScopedMcpServerConfig> = {}
  const errors: string[] = []
  for (const rawItem of items) {
    const item = rawItem.trim()
    if (!item) continue
    let inlineObject: unknown
    let isInline = false
    let jsonFault = ''
    try {
      inlineObject = JSON.parse(item)
      isInline = true
    } catch (error) {
      isInline = false
      jsonFault = error instanceof Error ? error.message : String(error)
    }
    if (!isInline && (item.startsWith('{') || item.startsWith('['))) {
      errors.push(`--mcp ${item.length > 60 ? `${item.slice(0, 60)}…` : item}: not valid JSON — ${jsonFault}`)
      continue
    }
    if (!isInline && !existsSync(item)) {
      errors.push(`--mcp ${item}: no such file — pass the path of a JSON file with mcpServers, or the JSON itself`)
      continue
    }
    const parsed = isInline
      ? parseMcpConfig({ configObject: inlineObject, expandVars: true, scope: 'dynamic' })
      : parseMcpConfigFromFilePath({ filePath: item, expandVars: true, scope: 'dynamic' })
    for (const entry of parsed.errors) errors.push(`${entry.path}: ${entry.message}`)
    Object.assign(servers, parsed.config?.mcpServers ?? {})
  }
  return { servers, errors }
}
