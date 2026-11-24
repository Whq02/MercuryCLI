import type { EngineConnectorV1, KitDialReceiptV1, McpRosterEntryV1, McpRosterV1 } from '../../engine/connector/types.js'


export const MCP_ORGAN_LINE = (name: string): string =>
  `MCP server "${name}" is Mercury's own organ — never dialed.`

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

const EMPTY_MCP_CLIENTS: readonly McpRosterEntryV1[] = Object.freeze([])

export function createMcpRosterStore(connector: Pick<EngineConnectorV1, 'mcpRoster' | 'subscribeModel'>) {
  const read = (): readonly McpRosterEntryV1[] => {
    const clients = connector.mcpRoster().clients
    return clients.length === 0 ? EMPTY_MCP_CLIENTS : clients
  }
  let current = read()
  return {
    getSnapshot: () => current,
    subscribe(listener: () => void) {
      const stop = connector.subscribeModel(() => {
        current = read()
        listener()
      })
      current = read()
      return stop
    },
  }
}
export function mcpRosterRowsFailedFirst(roster: McpRosterV1): McpRosterEntryV1[] {
  const failed = roster.clients.filter(entry => entry.type === 'failed')
  const rest = roster.clients.filter(entry => entry.type !== 'failed')
  return [...failed, ...rest]
}
