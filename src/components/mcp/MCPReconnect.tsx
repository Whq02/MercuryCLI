// The standalone reconnect screen behind `/mcp reconnect <name>`. Reports
// through the shared outcome mapper so it can never disagree with the server
// menus about what a post-reconnect client state means.

import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { useMcpReconnect } from '../../services/mcp/MCPConnectionManager.js'
import { useAppState } from '../../state/AppState.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { Spinner } from '../Spinner.js'
import { describeReconnectOutcome } from './utils/reconnectHelpers.js'

export function MCPReconnect({
  serverName,
  onComplete,
}: {
  serverName: string
  onComplete: LocalJSXCommandOnDone
}): React.ReactNode {
  const reconnect = useMcpReconnect()
  const clients = useAppState(state => state.mcp.clients)
  const [waiting, setWaiting] = useState(true)
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    const known = clients.some(client => client.name === serverName)
    if (!known) {
      setWaiting(false)
      onComplete(`MCP server ${serverName} was not found.`)
      return
    }

    void (async () => {
      try {
        const result = await reconnect(serverName)
        const outcome = describeReconnectOutcome(serverName, result.client)
        onComplete(outcome.message)
      } catch (error) {
        onComplete(
          `Reconnecting to ${serverName} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      } finally {
        setWaiting(false)
      }
    })()
  }, [clients, onComplete, reconnect, serverName])

  if (!waiting) return null
  return (
    <Box>
      <Spinner />
      <Text dimColor>
        {' '}
        Reconnecting to {serverName} — this can take a moment…
      </Text>
    </Box>
  )
}
