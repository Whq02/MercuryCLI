
import { useEffect, useRef } from 'react'
import { z } from 'zod'
import type { MCPServerConnection } from '../services/mcp/types.js'
import { getConnectedIdeClient } from '../utils/ide.js'
import { setMcpNotificationHandler } from '../services/mcp/zodInstanceSeam.js'
import { logError } from '../utils/log.js'

export type SelectionPoint = {
  line: number
  character: number
}

export type SelectionData = {
  start: SelectionPoint
  end: SelectionPoint
}

export type IDESelection = {
  lineCount: number
  text?: string
  filePath?: string
  lineStart?: number
}

const SelectionChangedNotificationSchema = z.object({
  method: z.literal('selection_changed'),
  params: z.object({
    selection: z
      .object({
        start: z.object({ line: z.number(), character: z.number() }),
        end: z.object({ line: z.number(), character: z.number() }),
      })
      .nullable()
      .optional(),
    text: z.string().optional(),
    filePath: z.string().optional(),
  }),
})

export function displayedLineOf(wireLine: number): number {
  return wireLine + 1
}

export function useIdeSelection(
  mcpClients: MCPServerConnection[],
  onSelect: (selection: IDESelection) => void,
): void {
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const registeredClientRef = useRef<unknown>(null)

  const ideClient = getConnectedIdeClient(mcpClients) ?? null

  useEffect(() => {
    if (registeredClientRef.current === ideClient) return
    registeredClientRef.current = ideClient
    onSelectRef.current({ lineCount: 0 })
    if (ideClient === null) return

    const report = (
      selection: SelectionData,
      text?: string,
      filePath?: string,
    ): void => {
      let lineCount = selection.end.line - selection.start.line + 1
      if (selection.end.character === 0 && lineCount > 1) lineCount--
      onSelectRef.current({
        lineCount,
        text,
        filePath,
        lineStart: displayedLineOf(selection.start.line),
      })
    }

    try {
      setMcpNotificationHandler(
        ideClient.client,
        SelectionChangedNotificationSchema,
        notification => {
          if (registeredClientRef.current !== ideClient) return
          try {
            const { selection, text, filePath } = notification.params
            if (selection) {
              report(selection, text, filePath)
            } else if (text !== undefined) {
            }
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
