import * as React from 'react'
import { useEffect, useRef } from 'react'
import { MCPReconnect } from '../../components/mcp/MCPReconnect.js'
import { MCPSettings } from '../../components/mcp/MCPSettings.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import { kitDialLine, mcpRosterLine, mcpRouteArm, MCP_ORGAN_LINE } from './route.js'

function McpToggle({
  action,
  target,
  onDone,
}: {
  action: 'enable' | 'disable'
  target: string
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const ranRef = useRef(false)
  useEffect(() => {
    if (ranRef.current) return
    ranRef.current = true
    void (async () => {
      const { getFocusedSessionConnector } = await import('../../services/engine-connector/focusedConnector.js')
      const { isMcpOrgan } = await import('../../services/mcp/membership.js')
      const connector = getFocusedSessionConnector()
      const roster = connector.mcpRoster()
      const on = action === 'enable'
      let dials: Array<{ name: string; on: boolean }>
      let asked: string
      if (target === 'all') {
        dials = roster.clients
          .filter(client => !isMcpOrgan(client.name))
          .filter(client => (on ? client.type === 'disabled' : client.type !== 'disabled'))
          .map(client => ({ name: client.name, on }))
        if (dials.length === 0) {
          onDone(`All MCP servers are already ${action}d.`)
          return
        }
        asked = `${on ? 'Enabled' : 'Disabled'} ${dials.length} MCP server${dials.length === 1 ? '' : 's'}`
      } else {
        if (isMcpOrgan(target)) {
          onDone(MCP_ORGAN_LINE(target))
          return
        }
        if (!roster.clients.some(client => client.name === target)) {
          onDone(`MCP server "${target}" not found.`)
          return
        }
        dials = [{ name: target, on }]
        asked = `MCP server "${target}" ${action}d`
      }
      const receipt = await connector.setKit({ mcp: dials })
      onDone(kitDialLine(receipt, asked))
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const [first, ...rest] = tokens

  if (first === 'reconnect' && rest.length > 0) {
    return <MCPReconnect serverName={rest.join(' ')} onComplete={onDone} />
  }
  if (first === 'enable' || first === 'disable') {
    const target = rest.length > 0 ? rest.join(' ') : 'all'
    return <McpToggle action={first} target={target} onDone={onDone} />
  }
  const { getFocusedSessionConnector } = await import('../../services/engine-connector/focusedConnector.js')
  const roster = getFocusedSessionConnector().mcpRoster()
  if (mcpRouteArm(roster, context.getAppState().mcp.clients.length) === 'facts') {
    onDone(mcpRosterLine(roster))
    return null
  }
  return <MCPSettings onComplete={onDone} />
}
