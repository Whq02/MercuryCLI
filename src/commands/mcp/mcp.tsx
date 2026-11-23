import * as React from 'react'
import { useRef } from 'react'
import { useLoad } from '../../screen/effects/effects.js'
import { CommandPopupLease } from '../../screen/overlays/CommandPopupSlot.js'
import { claimCommandPopup } from '../../screen/cockpit/commandPopup.js'
import { mcpPopupShapeFor } from './McpPopup.js'
import { getFocusedSessionConnector } from '../../engine/connector/focusedConnector.js'
import { MCPReconnect } from '../../screen/mcp/MCPReconnect.js'
import { MCPSettings } from '../../screen/mcp/MCPSettings.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../catalogue/command.js'
import { kitDialLine, MCP_ORGAN_LINE } from './route.js'

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
  useLoad(() => {
    if (ranRef.current) return
    ranRef.current = true
    void (async () => {
      const { isMcpOrgan } = await import('../../integrations/mcp/membership.js')
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
  void context
  const token = claimCommandPopup(mcpPopupShapeFor(getFocusedSessionConnector().mcpRoster().clients.length))
  return <CommandPopupLease token={token}><MCPSettings onComplete={onDone} /></CommandPopupLease>
}
