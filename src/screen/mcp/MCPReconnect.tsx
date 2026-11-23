import * as React from 'react'
import { useRef } from 'react'
import { useLoad } from '../effects/effects.js'
import { Box, Text } from '../themedRenderer.js'
import { getFocusedSessionConnector } from '../../engine/connector/focusedConnector.js'
import type { LocalJSXCommandOnDone } from '../../commands/catalogue/command.js'
import { Spinner } from '../spinner/Spinner.js'

export function MCPReconnect({ serverName, onComplete }: { serverName: string; onComplete: LocalJSXCommandOnDone }): React.ReactNode {
  const started = useRef(false)
  useLoad(() => {
    if (started.current) return
    started.current = true
    void getFocusedSessionConnector().mcpAction(serverName, 'reconnect').then(result => {
      onComplete(result.detail ?? `${serverName}: ${result.outcome}`)
    })
  }, [serverName, onComplete])
  return <Box><Spinner /><Text dimColor> Reconnecting to {serverName}…</Text></Box>
}
