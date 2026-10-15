
import { isMcpServerDisabled } from '../../services/mcp/config.js'
import { describeMcpPolicy, getMaxExposedRisk, isMcpPolicyActive } from '../../services/mcp/toolPolicy.js'
import { getProjectMcpConfigsFromCwd } from '../../services/mcp/config.js'
import { untrustedWorkspaceHeadless } from '../config.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import { getCurrentProjectConfig, getGlobalConfig } from '../config.js'
import { withState, type Snapshot, type SnapshotState } from './types.js'

export type McpServerState =
  | 'ready'
  | 'starting'
  | 'needs-auth'
  | 'failed'
  | 'disabled'
  | 'configured'

export interface McpServerRow {
  name: string
  state: McpServerState
  detail: string
  source: 'config' | 'runtime'
  connection?: MCPServerConnection
  error?: string
}

export interface McpCounts {
  ready: number
  starting: number
  needsAuth: number
  failed: number
  disabled: number
  configured: number
  total: number
}

export type McpData = {
  servers: McpServerRow[]
  names: string[]
  counts: McpCounts
  maxRisk: string
  mcpPolicyActive: boolean
  mcpPolicyHint: string
  runtimeStampedAt: number | null
}

export interface McpRuntimeSnapshot {
  connections: MCPServerConnection[]
  stampedAt: number
}

let latest: McpRuntimeSnapshot | null = null
let version = 0
const listeners = new Set<() => void>()

export function publishMcpConnections(connections: MCPServerConnection[]): void {
  latest = { connections, stampedAt: Date.now() }
  version += 1
  for (const cb of listeners) {
    try {
      cb()
    } catch {
    }
  }
}

export function mcpConnectionsSnapshot(): McpRuntimeSnapshot | null {
  return latest
}

export function subscribeMcpGauge(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function getMcpGaugeVersion(): number {
  return version
}


function bounded(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`
}

function rowFor(
  name: string,
  connection: MCPServerConnection | undefined,
  source: McpServerRow['source'],
): McpServerRow {
  if (connection === undefined) {
    let disabled = false
    try {
      disabled = isMcpServerDisabled(name)
    } catch {
      disabled = false
    }
    if (disabled) return { name, state: 'disabled', detail: 'disabled in config', source }
    return {
      name,
      state: 'configured',
      detail: 'configured — no connection in this process (connects at session start or on demand)',
      source,
    }
  }
  switch (connection.type) {
    case 'connected':
      return { name, state: 'ready', detail: 'connected in this process', source, connection }
    case 'pending': {
      const attempt =
        connection.reconnectAttempt !== undefined
          ? ` (attempt ${connection.reconnectAttempt}${
              connection.maxReconnectAttempts !== undefined ? `/${connection.maxReconnectAttempts}` : ''
            })`
          : ''
      return { name, state: 'starting', detail: `connect in flight${attempt}`, source, connection }
    }
    case 'needs-auth':
      return { name, state: 'needs-auth', detail: 'server requires authentication', source, connection }
    case 'failed': {
      const error = connection.error ? bounded(connection.error, 140) : undefined
      return {
        name,
        state: 'failed',
        detail: `connection failed${error ? `: ${error}` : ''}`,
        source,
        connection,
        ...(error ? { error } : {}),
      }
    }
    case 'disabled':
      return { name, state: 'disabled', detail: 'disabled in config', source, connection }
  }
}

function countRows(servers: McpServerRow[]): McpCounts {
  const counts: McpCounts = {
    ready: 0,
    starting: 0,
    needsAuth: 0,
    failed: 0,
    disabled: 0,
    configured: 0,
    total: servers.length,
  }
  for (const s of servers) {
    if (s.state === 'ready') counts.ready += 1
    else if (s.state === 'starting') counts.starting += 1
    else if (s.state === 'needs-auth') counts.needsAuth += 1
    else if (s.state === 'failed') counts.failed += 1
    else if (s.state === 'disabled') counts.disabled += 1
    else counts.configured += 1
  }
  return counts
}

const SOURCE = 'config.mcpServers ⊕ this process'

export function mcpGauge(): Snapshot<{ data: McpData }> {
  let maxRisk = 'high'
  let mcpPolicyActive = false
  let mcpPolicyHint = 'high · permissive'
  try {
    maxRisk = getMaxExposedRisk()
    mcpPolicyActive = isMcpPolicyActive()
    mcpPolicyHint = describeMcpPolicy()
  } catch {
  }
  const runtime = mcpConnectionsSnapshot()
  const runtimeStampedAt = runtime?.stampedAt ?? null
  const byName = new Map<string, MCPServerConnection>()
  for (const c of runtime?.connections ?? []) byName.set(c.name, c)

  let names: string[]
  try {
    const g = getGlobalConfig()
    const p = getCurrentProjectConfig()
    let projectNames: string[] = []
    try {
      if (!untrustedWorkspaceHeadless()) {
        projectNames = Object.keys(getProjectMcpConfigsFromCwd().servers)
      }
    } catch {
    }
    names = Array.from(
      new Set([...Object.keys(g?.mcpServers ?? {}), ...Object.keys(p?.mcpServers ?? {}), ...projectNames]),
    ).sort()
  } catch {
    const servers = [...byName.entries()].map(([name, c]) => rowFor(name, c, 'runtime'))
    return withState(
      'unavailable',
      { servers, names: [], counts: countRows(servers), maxRisk, mcpPolicyActive, mcpPolicyHint, runtimeStampedAt },
      'mcp config unreadable',
      SOURCE,
    )
  }

  const servers: McpServerRow[] = []
  for (const name of names) {
    const c = byName.get(name)
    byName.delete(name)
    servers.push(rowFor(name, c, 'config'))
  }
  for (const [name, c] of byName) servers.push(rowFor(name, c, 'runtime'))
  const counts = countRows(servers)

  if (servers.length === 0) {
    return withState(
      'off',
      { servers, names, counts, maxRisk, mcpPolicyActive, mcpPolicyHint, runtimeStampedAt },
      'no MCP servers configured',
      'config.mcpServers',
    )
  }
  return {
    state: 'live',
    source: SOURCE,
    data: { servers, names, counts, maxRisk, mcpPolicyActive, mcpPolicyHint, runtimeStampedAt },
  }
}

export function mcpServerSnapshotState(state: McpServerState): SnapshotState {
  switch (state) {
    case 'ready':
      return 'ready'
    case 'starting':
      return 'starting'
    case 'needs-auth':
      return 'degraded'
    case 'failed':
      return 'failed'
    case 'disabled':
      return 'disabled'
    default:
      return 'configured'
  }
}

export function mcpCountsLabel(counts: McpCounts): string {
  const parts: string[] = []
  if (counts.ready > 0) parts.push(`${counts.ready} ready`)
  if (counts.starting > 0) parts.push(`${counts.starting} connecting`)
  if (counts.needsAuth > 0) parts.push(`${counts.needsAuth} need${counts.needsAuth === 1 ? 's' : ''} auth`)
  if (counts.failed > 0) parts.push(`${counts.failed} failed`)
  if (counts.disabled > 0) parts.push(`${counts.disabled} off`)
  if (counts.configured > 0) parts.push(`${counts.configured} configured`)
  return parts.join(' · ')
}

export function resetMcpGaugeForTests(): void {
  latest = null
  version += 1
}
