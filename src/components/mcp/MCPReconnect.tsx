import * as React from 'react'
import { useEffect, useRef } from 'react'
import { Box, Text } from '../../ink.js'
import { getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { Spinner } from '../Spinner.js'

export function MCPReconnect({ serverName, onComplete }: { serverName: string; onComplete: LocalJSXCommandOnDone }): React.ReactNode {
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    void getFocusedSessionConnector().mcpAction(serverName, 'reconnect').then(result => {
      onComplete(result.detail ?? `${serverName}: ${result.outcome}`)
    })
  }, [serverName, onComplete])
  return <Box><Spinner /><Text dimColor> Reconnecting to {serverName}…</Text></Box>
}
