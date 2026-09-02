import type { KitDialReceiptV1, McpRosterEntryV1, McpRosterV1 } from '../../services/engine-connector/types.js'


export type McpRouteArm = 'facts' | 'panel'

export function mcpRouteArm(roster: McpRosterV1, screenClientCount: number): McpRouteArm {
  if (roster.clients.length > 0) return 'facts'
  return screenClientCount === 0 ? 'facts' : 'panel'
}

export const MCP_EMPTY_ROSTER_LINE =
  "No MCP servers in this session. The boot menu's MCPs & Skills sets the next session's; .mcp.json or settings.json add new ones."

export const MCP_ORGAN_LINE = (name: string): string =>
  `MCP server "${name}" is Mercury's own organ — never dialed. The ide connection is owned by /ide.`

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

export function mcpRosterRow(entry: McpRosterEntryV1): string {
  const state = `${entry.name} (${entry.type})`
  return entry.error !== undefined && entry.error !== '' ? `${state} — ${entry.error}` : state
}

export function mcpRosterRowsFailedFirst(roster: McpRosterV1): McpRosterEntryV1[] {
  const failed = roster.clients.filter(entry => entry.type === 'failed')
  const rest = roster.clients.filter(entry => entry.type !== 'failed')
  return [...failed, ...rest]
}

export function mcpRosterLine(roster: McpRosterV1): string {
  if (roster.clients.length === 0) return MCP_EMPTY_ROSTER_LINE
  return `The session's MCP servers: ${mcpRosterRowsFailedFirst(roster).map(mcpRosterRow).join(' · ')}. The session's runner owns them — this session only, the boot menu sets the next session's; per-server toggles ride /mcp enable|disable <name>.`
}
