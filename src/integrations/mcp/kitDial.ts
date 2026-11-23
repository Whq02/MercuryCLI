import type { AppState } from '../../screen/app-state/AppStateStore.js'
import type { SessionKitV1 } from '../../daemon/session-seat/sessionKit.js'
import { getMcpPrefix } from '../mcp-shapes/mcpToolNames.js'
import { isMcpOrgan, kitMembership } from './membership.js'
import { pruneStaleMcpResourceTools } from './client.js'
import type { ScopedMcpServerConfig } from '../mcp-shapes/mcpServerRecords.js'

function kitSpokenMcpNames(kit: SessionKitV1 | undefined): readonly string[] {
  if (kit === undefined) return []
  if (kit.resolved === false) return kit.deltas?.mcpOff ?? []
  return kit.mcp
}

export function kitDialCandidates(
  before: SessionKitV1 | undefined,
  after: SessionKitV1 | undefined,
  rowNames: readonly string[],
): string[] {
  const out: string[] = []
  for (const name of [...rowNames, ...kitSpokenMcpNames(before), ...kitSpokenMcpNames(after)]) {
    if (!out.includes(name)) out.push(name)
  }
  return out
}

export function kitEditMcpDelta(
  before: SessionKitV1 | undefined,
  after: SessionKitV1 | undefined,
  candidates: readonly string[],
): { connect: string[]; disconnect: string[] } {
  const connect: string[] = []
  const disconnect: string[] = []
  for (const name of candidates) {
    if (isMcpOrgan(name)) continue
    const was = kitMembership(before, name)
    const is = kitMembership(after, name)
    if (was === is) continue
    ;(is ? connect : disconnect).push(name)
  }
  return { connect, disconnect }
}

export function dropMcpServerFromAppState(
  previous: AppState,
  serverName: string,
  config: ScopedMcpServerConfig,
): AppState {
  const prefix = getMcpPrefix(serverName)
  const nextClients = previous.mcp.clients.map(candidate =>
    candidate.name === serverName
      ? { name: serverName, type: 'disabled' as const, config }
      : candidate,
  )
  return {
    ...previous,
    mcp: {
      ...previous.mcp,
      clients: nextClients,
      tools: pruneStaleMcpResourceTools(
        nextClients,
        previous.mcp.tools.filter(tool => !tool.name.startsWith(prefix)),
      ),
      commands: previous.mcp.commands.filter(
        candidate => !candidate.name.startsWith(prefix),
      ),
      resources: Object.fromEntries(
        Object.entries(previous.mcp.resources ?? {}).filter(([key]) => key !== serverName),
      ),
    },
  }
}
