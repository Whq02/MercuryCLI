import type { KitDialReceiptV1, McpRosterEntryV1, McpRosterV1 } from '../../services/engine-connector/types.js'

// ============================================================================
//  commands/mcp/route — the ONE arm table for /mcp on every seat.
//
//  THE LAW (the facts-fed precedent made total): /mcp answers from the
//  FOCUSED SESSION's roster over its connector's facts — the session's
//  runner owns its MCP servers, so the screen's own client list is never the
//  session's roster. A session with servers of its own is answered from its
//  facts on every seat, the chat pane included; the settings panel serves
//  only a screen that carries clients of its own while the focused session
//  carries none (the --mcp-config cockpit). The shape that fell between the
//  two arms — a populated runner roster beside a screen list that was not
//  empty — painted the screen's panel, and the session's servers never
//  reached the row.
// ============================================================================

export type McpRouteArm = 'facts' | 'panel'

/** Which arm serves /mcp: the focused roster's facts, or the screen's own
 *  settings panel. */
export function mcpRouteArm(roster: McpRosterV1, screenClientCount: number): McpRouteArm {
  if (roster.clients.length > 0) return 'facts'
  return screenClientCount === 0 ? 'facts' : 'panel'
}

/** The empty roster's one honest line (contract data). */
export const MCP_EMPTY_ROSTER_LINE =
  "No MCP servers in this session. The boot menu's MCPs & Skills sets the next session's; .mcp.json or settings.json add new ones."

/** An organ is Mercury's own — a dial never severs it (contract data). */
export const MCP_ORGAN_LINE = (name: string): string =>
  `MCP server "${name}" is Mercury's own organ — never dialed. The ide connection is owned by /ide.`

/**
 * The dial receipt's one honest line (the sentences live HERE —
 * route.ts owns the /mcp grammar, the composer stays thin): applied says
 * SESSION scope and points at the menu for the next session; queued speaks
 * the daemon's own turn's-end sentence — a mid-turn dial is never silent;
 * noop and refused carry the writer's typed detail.
 */
export function kitDialLine(receipt: KitDialReceiptV1, asked: string): string {
  switch (receipt.outcome) {
    case 'applied':
      return `${asked} — this session only; the boot menu sets the next session's.`
    case 'queued':
      return `Queued — ${receipt.detail ?? 'the dials apply when this turn ends'}.`
    case 'noop':
      return `No change — ${receipt.detail ?? 'the kit already reads so'}.`
    case 'refused':
      return `The dial refused — ${receipt.detail ?? 'no detail'}.`
  }
}

/** One roster row: the server's name, its connection state, and — on a
 *  failed row — the deadline's honest reason in the panel's own words. */
export function mcpRosterRow(entry: McpRosterEntryV1): string {
  const state = `${entry.name} (${entry.type})`
  return entry.error !== undefined && entry.error !== '' ? `${state} — ${entry.error}` : state
}

/** The roster as the face's one line. */
export function mcpRosterLine(roster: McpRosterV1): string {
  if (roster.clients.length === 0) return MCP_EMPTY_ROSTER_LINE
  return `The session's MCP servers: ${roster.clients.map(mcpRosterRow).join(' · ')}. The session's runner owns them — this session only, the boot menu sets the next session's; per-server toggles ride /mcp enable|disable <name>.`
}
