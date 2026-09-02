// IDE log-event handler registration (KEEP the no-op
// registration). Registering accepts the extension's `log_event`
// notifications instead of erroring them; the handler body is deliberately
// inert — the telemetry sink is folded out. Registered only when the
// client list is non-empty.

import { useEffect, useRef } from 'react'
import { z } from 'zod'
import type { MCPServerConnection } from '../services/mcp/types.js'
import { getConnectedIdeClient } from '../utils/ide.js'
import { setMcpNotificationHandler } from '../services/mcp/zodInstanceSeam.js'
import { logError } from '../utils/log.js'

const LogEventNotificationSchema = z.object({
  method: z.literal('log_event'),
  params: z.object({
    eventName: z.string(),
    eventData: z.record(z.string(), z.unknown()).optional(),
  }),
})

export function useIdeLogging(mcpClients: MCPServerConnection[]): void {
  const registeredClientRef = useRef<unknown>(null)
  const ideClient =
    mcpClients.length > 0 ? getConnectedIdeClient(mcpClients) : undefined

  useEffect(() => {
    if (!ideClient) return
    if (registeredClientRef.current === ideClient) return
    registeredClientRef.current = ideClient
    try {
      setMcpNotificationHandler(ideClient.client, LogEventNotificationSchema, () => {
        // Accepted, not sinked: the destination is folded out.
      })
    } catch (error) {
      logError(error)
    }
  }, [ideClient])
}
