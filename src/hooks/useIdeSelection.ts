// IDE selection tracking. Re-registers when the connected client
// changes, treating "no client" and "null client" as the same state so
// routine client-list updates cause no spurious resets, registering at
// most once per client. A client change RESETS the selection (zero lines,
// no path or text) before re-registering. The line count is the inclusive
// span, decremented when the end sits on character zero of a line — a line
// whose first character is the boundary is not counted as selected. The
// wire's start line is ZERO-based (both editor companions hand their
// editor's native position through); the reported start is the ONE-based
// line the editor displays, so "lines 13–16" in context names the lines
// the operator sees (sweep #2 item 79 — an off-by-one into the
// model's context is a lie about the selection, law 1). The "empty
// selection" wire shape (text only) routes into the same reporter, which
// requires both start and end — so it reports NOTHING; that behaviour is
// deliberate and reproduced.

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

/** Zero-based editor position → the one-based line number the editor
 *  shows. Pure; exported for the parity prover. */
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
    // "No client" ≡ "null client": routine list updates must not reset.
    if (registeredClientRef.current === ideClient) return
    registeredClientRef.current = ideClient
    // Reset BEFORE re-registering.
    onSelectRef.current({ lineCount: 0 })
    if (ideClient === null) return

    const report = (
      selection: SelectionData,
      text?: string,
      filePath?: string,
    ): void => {
      let lineCount = selection.end.line - selection.start.line + 1
      // An end on character zero does not count that line as selected.
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
              // The empty-selection shape: the reporter requires both start
              // and end, so this branch reports nothing at all.
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
