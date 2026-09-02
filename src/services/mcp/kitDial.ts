// ============================================================================
//  services/mcp/kitDial — the DIAL's pure halves (ledger L24(3)).
//
//  A session dial's live MCP effect is a RECONCILE over the catalogue plane:
//  the latch flips to the new kit, and every catalogue server whose
//  membership CHANGED connects or disconnects — nothing else moves (absent ≠
//  empty; a dial is a delta, never a full-state heal: a failed-but-member
//  row is not retried, a disabled non-member row is not re-seeded). This
//  module holds the pure halves so the provers drive them without a process:
//    · the CANDIDATE set and the DELTA — which names flip, from the kit
//      before and the kit after, membership answered by the one owner's
//      predicate (kitMembership; organs skipped: a dial never severs the
//      coordination server or the ide bridge);
//    · the DROP updater — the teardown's AppState transition (row →
//      'disabled', the server's tools/commands gone by prefix, its resource
//      slice gone by key), extracted verbatim from the child's mcp_toggle
//      arm so both arms share one spelling.
//  The impure halves (clearServerCache, connectToServer, the per-turn
//  handler registration) stay with their owners in the child loop.
// ============================================================================
import type { AppState } from '../../state/AppStateStore.js'
import type { SessionKitV1 } from '../../daemon/sessionKit.js'
import { getMcpPrefix } from './mcpStringUtils.js'
import { isMcpOrgan, kitMembership } from './membership.js'
import type { ScopedMcpServerConfig } from './types.js'

/** The names a kit SPEAKS about MCP membership: a resolved kit's closed
 *  list; an unresolved kit's off-deltas (its provisional lists are never
 *  read — the lead-ruled law). Undefined speaks none (the record arm). */
function kitSpokenMcpNames(kit: SessionKitV1 | undefined): readonly string[] {
  if (kit === undefined) return []
  if (kit.resolved === false) return kit.deltas?.mcpOff ?? []
  return kit.mcp
}

/** Every name whose membership COULD have flipped: the live rows plus every
 *  name either kit speaks about. Deduplicated, row order first. */
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

/** The dial's MCP delta: which candidates flipped OFF→ON (connect) and
 *  ON→OFF (disconnect) between the two kits. Membership is the one owner's
 *  predicate; organs are skipped whole — a kit never governs them. */
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

/**
 * The teardown's AppState transition (one spelling for the child's
 * mcp_toggle arm and the kit_edit reconcile): the row survives as a
 * truthful 'disabled' entry carrying its config, and everything the server
 * contributed leaves — tools and commands by the server's own prefix, the
 * resource slice by key.
 */
export function dropMcpServerFromAppState(
  previous: AppState,
  serverName: string,
  config: ScopedMcpServerConfig,
): AppState {
  const prefix = getMcpPrefix(serverName)
  return {
    ...previous,
    mcp: {
      ...previous.mcp,
      clients: previous.mcp.clients.map(candidate =>
        candidate.name === serverName
          ? { name: serverName, type: 'disabled' as const, config }
          : candidate,
      ),
      tools: previous.mcp.tools.filter(tool => !tool.name.startsWith(prefix)),
      commands: previous.mcp.commands.filter(
        candidate => !candidate.name.startsWith(prefix),
      ),
      resources: Object.fromEntries(
        Object.entries(previous.mcp.resources ?? {}).filter(([key]) => key !== serverName),
      ),
    },
  }
}
