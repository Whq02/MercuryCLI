// IDE at-mention notifications: registers on the connected IDE
// client and converts the wire's ZERO-based line numbers to one-based
// before reporting. Invocations from a superseded client reference are
// ignored; errors are logged, never thrown. No cleanup — MCP clients own
// their own lifecycle.

import { useEffect, useRef } from 'react'
import { z } from 'zod'
import type { MCPServerConnection } from '../services/mcp/types.js'
import { getConnectedIdeClient } from '../utils/ide.js'
import { setMcpNotificationHandler } from '../services/mcp/zodInstanceSeam.js'
import { logError } from '../utils/log.js'

export type IDEAtMentioned = {
  filePath: string
  lineStart?: number
  lineEnd?: number
}

const AtMentionedNotificationSchema = z.object({
  method: z.literal('at_mentioned'),
  params: z.object({
    filePath: z.string(),
    lineStart: z.number().optional(),
    lineEnd: z.number().optional(),
  }),
})

export function useIdeAtMentioned(
  mcpClients: MCPServerConnection[],
  onAtMentioned: (mention: IDEAtMentioned) => void,
): void {
  const onAtMentionedRef = useRef(onAtMentioned)
  onAtMentionedRef.current = onAtMentioned
  const registeredClientRef = useRef<unknown>(null)

  const ideClient = getConnectedIdeClient(mcpClients)

  useEffect(() => {
    if (!ideClient) return
    if (registeredClientRef.current === ideClient) return
    registeredClientRef.current = ideClient
    try {
      setMcpNotificationHandler(
        ideClient.client,
        AtMentionedNotificationSchema,
        notification => {
          // A handler from a superseded client must not report.
          if (registeredClientRef.current !== ideClient) return
          try {
            const { filePath, lineStart, lineEnd } = notification.params
            onAtMentionedRef.current({
              filePath,
              // Zero-based on the wire; one-based on receipt.
              lineStart: lineStart !== undefined ? lineStart + 1 : undefined,
              lineEnd: lineEnd !== undefined ? lineEnd + 1 : undefined,
            })
          } catch (error) {
            logError(error)
          }
        },
      )
    } catch (error) {
      logError(error)
    }
  }, [ideClient])
}
