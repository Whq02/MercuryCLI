
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
  openFiles?: string[]
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

const EditorContextNotificationSchema = z.object({
  method: z.literal('editor_context'),
  params: z.object({
    openFiles: z.array(z.string()).optional(),
  }),
})

export function displayedLineOf(wireLine: number): number {
  return wireLine + 1
}

export function selectionOf(
  selection: SelectionData,
  text: string | undefined,
  filePath: string | undefined,
  openFiles: string[] | undefined,
): IDESelection {
  let lineCount = selection.end.line - selection.start.line + 1
  if (selection.end.character === 0 && lineCount > 1) lineCount--
  return {
    lineCount,
    text,
    filePath,
    lineStart: displayedLineOf(selection.start.line),
    ...(openFiles !== undefined ? { openFiles } : {}),
  }
}

export function withOpenFiles(
  previous: IDESelection,
  openFiles: string[] | undefined,
): IDESelection {
  const next: IDESelection = { ...previous }
  if (openFiles === undefined) delete next.openFiles
  else next.openFiles = openFiles
  return next
}

type IdeNotificationClient = Parameters<typeof setMcpNotificationHandler>[0]

export function registerIdeSelectionHandlers(
  client: IdeNotificationClient,
  live: () => boolean,
  latest: () => IDESelection,
  emit: (next: IDESelection) => void,
): void {
  setMcpNotificationHandler(
    client,
    SelectionChangedNotificationSchema,
    notification => {
      if (!live()) return
      try {
        const { selection, text, filePath } = notification.params
        if (selection) {
          emit(selectionOf(selection, text, filePath, latest().openFiles))
        } else if (text !== undefined) {
        }
      } catch (error) {
        logError(error)
      }
    },
  )
  setMcpNotificationHandler(
    client,
    EditorContextNotificationSchema,
    notification => {
      if (!live()) return
      try {
        emit(withOpenFiles(latest(), notification.params.openFiles))
      } catch (error) {
        logError(error)
      }
    },
  )
}

export function useIdeSelection(
  mcpClients: MCPServerConnection[],
  onSelect: (selection: IDESelection) => void,
): void {
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const registeredClientRef = useRef<unknown>(null)
  const latestRef = useRef<IDESelection>({ lineCount: 0 })

  const ideClient = getConnectedIdeClient(mcpClients) ?? null

  useEffect(() => {
    if (registeredClientRef.current === ideClient) return
    registeredClientRef.current = ideClient
    const emit = (next: IDESelection): void => {
      latestRef.current = next
      onSelectRef.current(next)
    }
    emit({ lineCount: 0 })
    if (ideClient === null) return

    try {
      registerIdeSelectionHandlers(
        ideClient.client,
        () => registeredClientRef.current === ideClient,
        () => latestRef.current,
        emit,
      )
    } catch (error) {
      logError(error)
    }
  }, [ideClient])
}
