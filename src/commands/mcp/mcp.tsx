import * as React from 'react'
import { useEffect, useRef } from 'react'
import { MCPReconnect } from '../../components/mcp/MCPReconnect.js'
import { MCPSettings } from '../../components/mcp/MCPSettings.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import { kitDialLine, mcpRosterLine, mcpRouteArm, MCP_ORGAN_LINE } from './route.js'

/**
 * THE SESSION DIAL (ledger L24(3): "if I turn off the skills
 * there in that session, then that session just doesn't have that skill
 * anymore, but it doesn't apply to my boot menu… same with the MCP").
 * /mcp enable|disable rides the FOCUSED SESSION's connector verb — the
 * record's one writer plus the live forward — never the screen's own client
 * walk (the old road ran in the screen process against the screen's
 * clients and PERSISTED to the shared project config: the exact isolation
 * violation), and never any config file. One-shot, ref-guarded.
 */
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
        // Over the SESSION's roster (never a client walk); organs are
        // Mercury's own and never dialed.
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

  // `no-redirect` is an explicit test escape hatch straight to the view.
  if (first === 'reconnect' && rest.length > 0) {
    // Re-joined with single spaces so server names may contain spaces.
    return <MCPReconnect serverName={rest.join(' ')} onComplete={onDone} />
  }
  if (first === 'enable' || first === 'disable') {
    const target = rest.length > 0 ? rest.join(' ') : 'all'
    return <McpToggle action={first} target={target} onDone={onDone} />
  }
  // /mcp IS THE FOCUSED SESSION'S ROSTER on every seat (the arm table in
  // ./route.ts): the session's runner owns its MCP servers (the one-owner
  // law), the connector's facts answer for them, and the settings panel
  // serves only a screen that carries clients of its own while the focused
  // session carries none.
  const { getFocusedSessionConnector } = await import('../../services/engine-connector/focusedConnector.js')
  const roster = getFocusedSessionConnector().mcpRoster()
  if (mcpRouteArm(roster, context.getAppState().mcp.clients.length) === 'facts') {
    onDone(mcpRosterLine(roster))
    return null
  }
  return <MCPSettings onComplete={onDone} />
}
