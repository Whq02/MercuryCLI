// ============================================================================
//  mcpGauge — the ONE owner of the MCP line.
//
//  Every surface that paints MCP servers (the deck row, the policy panel,
//  /status, the /mcp list, the health certificate, the readiness center,
//  doctor --json) reads THIS gauge. It joins the only two facts that exist:
//    · the CONFIGURED set — global ⊕ project `mcpServers` (plus the
//      per-server disabled marks), and
//    · this process's LIVE connections — the REPL's connection manager
//      publishes its merged client list here on every change.
//  Configuration alone is the `configured` state; only a live connection in
//  THIS process reads `ready`. An empty runtime half (a headless doctor run,
//  a fresh boot) is an honest state: every configured row stays `configured`,
//  never a fabricated `ready`.
//
//  LIVE: each publish bumps a version; a subscribed surface repaints the
//  instant a server connects, fails, needs auth, or is disabled. The
//  configured half is a cheap config-cache read per gauge read, so a server
//  added by /mcp appears with the manager's next publish for it.
//
//  Render-safe and never-throws: a config read that fails is an honest
//  `unavailable` gauge (the runtime rows still tell their truth), never a
//  crash on the render path. The policy facts (max exposed risk, the active
//  boolean, the hint) ride every arm so a panel can colour off the BOOLEAN,
//  never off the displayed risk word.
// ============================================================================

import { isMcpServerDisabled } from '../../services/mcp/config.js'
import { describeMcpPolicy, getMaxExposedRisk, isMcpPolicyActive } from '../../services/mcp/toolPolicy.js'
import { getProjectMcpConfigsFromCwd } from '../../services/mcp/config.js'
import { untrustedWorkspaceHeadless } from '../config.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import { getCurrentProjectConfig, getGlobalConfig } from '../config.js'
import { withState, type Snapshot, type SnapshotState } from './types.js'

/** One server's liveness word — the readiness vocabulary's MCP subset. */
export type McpServerState =
  | 'ready' // connected in this process
  | 'starting' // a connect is in flight (reconnect attempts counted)
  | 'needs-auth' // the server wants authentication before it serves
  | 'failed' // the last live attempt failed
  | 'disabled' // deliberately off in config
  | 'configured' // config exists; no connection in this process yet

export interface McpServerRow {
  name: string
  state: McpServerState
  /** One honest line — what the state rests on, in the operator's words. */
  detail: string
  /** 'config' rows come from mcpServers; 'runtime' rows are injected clients
   *  (an SDK client, the editor bridge) that have no config row. */
  source: 'config' | 'runtime'
  /** The live connection record when this process holds one. */
  connection?: MCPServerConnection
  /** The failure text, bounded, when the state is `failed`. */
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
  /** Every server row — config rows first (sorted), then runtime-only rows. */
  servers: McpServerRow[]
  /** The configured names (global ⊕ project), sorted. */
  names: string[]
  counts: McpCounts
  maxRisk: string
  mcpPolicyActive: boolean
  mcpPolicyHint: string
  /** Epoch ms of the last runtime publish; null before this process has
   *  connected anything. */
  runtimeStampedAt: number | null
}

export interface McpRuntimeSnapshot {
  connections: MCPServerConnection[]
  stampedAt: number
}

// ── the runtime half: the connection manager's publish seam ────────────────
let latest: McpRuntimeSnapshot | null = null
let version = 0
const listeners = new Set<() => void>()

/** REPL-side publish — called whenever the merged client list changes. */
export function publishMcpConnections(connections: MCPServerConnection[]): void {
  latest = { connections, stampedAt: Date.now() }
  version += 1
  for (const cb of listeners) {
    try {
      cb()
    } catch {
      /* a broken subscriber never blocks the publisher */
    }
  }
}

/** Latest published connections, or null when this process never connected. */
export function mcpConnectionsSnapshot(): McpRuntimeSnapshot | null {
  return latest
}

export function subscribeMcpGauge(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Monotonic publish version — the useSyncExternalStore snapshot. */
export function getMcpGaugeVersion(): number {
  return version
}

// ── the join ────────────────────────────────────────────────────────────────

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

/**
 * The gauge — a sync, render-safe read. `off` when nothing is configured and
 * nothing is connected (a valid state, not an error); `unavailable` when the
 * config cannot be read; `live` with rows otherwise.
 */
export function mcpGauge(): Snapshot<{ data: McpData }> {
  let maxRisk = 'high'
  let mcpPolicyActive = false
  let mcpPolicyHint = 'high · permissive'
  try {
    maxRisk = getMaxExposedRisk()
    mcpPolicyActive = isMcpPolicyActive()
    mcpPolicyHint = describeMcpPolicy()
  } catch {
    /* keep defaults */
  }
  const runtime = mcpConnectionsSnapshot()
  const runtimeStampedAt = runtime?.stampedAt ?? null
  const byName = new Map<string, MCPServerConnection>()
  for (const c of runtime?.connections ?? []) byName.set(c.name, c)

  let names: string[]
  try {
    const g = getGlobalConfig()
    const p = getCurrentProjectConfig()
    // The PROJECT scope (.mcp.json) joins the census (FC-148): the gauge
    // read only the user scope and the global store's per-project slice, so
    // doctor said "no MCP servers configured" in a directory whose
    // .mcp.json the mcp verbs list and spawn seconds later — the one
    // surface an operator runs first on unfamiliar code was the one that
    // could not see it. Current-dir read (the sync exported seam); gated
    // exactly like the assembly: an untrusted headless run loads none, so
    // the gauge counts none (FC-144 parity).
    let projectNames: string[] = []
    try {
      if (!untrustedWorkspaceHeadless()) {
        projectNames = Object.keys(getProjectMcpConfigsFromCwd().servers)
      }
    } catch {
      /* the two standing scopes still answer */
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

/** The snapshot-state word a row paints through StateBadge / stateStyleOf. */
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

/** The one-line count summary: `2 ready · 1 needs auth` (zero counts are
 *  omitted; an all-configured set says `3 configured`). */
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

/** Proof seam: forget the runtime publish (session code never calls this). */
export function resetMcpGaugeForTests(): void {
  latest = null
  version += 1
}
