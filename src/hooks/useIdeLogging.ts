
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
      })
    } catch (error) {
      logError(error)
    }
  }, [ideClient])
}
