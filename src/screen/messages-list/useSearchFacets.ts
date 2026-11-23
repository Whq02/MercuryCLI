import { useCallback, useMemo, useRef } from 'react'
import type { RenderableMessage } from '../../engine/message-shapes/message.js'
import { renderableSearchText, toolInputFiles, EMPTY_FACETS } from '../virtual-message-list/transcriptSearch.js'
import { findToolByName } from '../../tools/kit/tool.js'
import type { MessagesProps, RowExpansionState, TranscriptRowsState } from './shapes.js'

export function useSearchFacets({ lookups, lookupsRef, tools }: { lookups: TranscriptRowsState['lookups']; lookupsRef: RowExpansionState['lookupsRef']; tools: MessagesProps['tools'] }) {
  const searchTextCache = useRef(new WeakMap<object, string>())
  const extractSearchText = useCallback(
    (message: RenderableMessage): string => {
      const cached = searchTextCache.current.get(message)
      if (cached !== undefined) return cached
      const lowered = renderableSearchText(
        message as Parameters<typeof renderableSearchText>[0],
        id => {
          const name = lookupsRef.current.toolUseByToolUseID.get(id)?.name
          return name === undefined ? undefined : findToolByName(tools, name)
        },
      ).toLowerCase()
      searchTextCache.current.set(message, lowered)
      return lowered
    },
    [tools],
  )

  const facetsCache = useMemo(
    () => new WeakMap<object, { tools: string[]; files: string[]; failed: boolean }>(),
    [lookups],
  )
  const extractFacets = useCallback(
    (message: RenderableMessage) => {
      const cached = facetsCache.get(message)
      if (cached !== undefined) return cached
      const live = lookupsRef.current
      let names: string[] = []
      let files: string[] = []
      let failed = false
      if (message.type === 'assistant') {
        const content = Array.isArray(message.message.content)
          ? message.message.content
          : []
        for (const block of content) {
          if (block.type !== 'tool_use') continue
          names.push(block.name)
          files = files.concat(toolInputFiles(block.input))
          if (
            live.erroredToolUseIDs.has(block.id) ||
            live.deniedToolUseIDs.has(block.id)
          ) {
            failed = true
          }
        }
      } else if (message.type === 'user') {
        const content = message.message.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type !== 'tool_result') continue
            const id = (block as { tool_use_id?: string }).tool_use_id
            const toolUse = id ? live.toolUseByToolUseID.get(id) : undefined
            if (toolUse) {
              names.push(toolUse.name)
              files = files.concat(toolInputFiles(toolUse.input))
            }
            if (
              (block as { is_error?: boolean }).is_error ||
              (id !== undefined &&
                (live.erroredToolUseIDs.has(id) || live.deniedToolUseIDs.has(id)))
            ) {
              failed = true
            }
          }
        }
      }
      const facets =
        names.length === 0 && files.length === 0 && !failed
          ? EMPTY_FACETS
          : { tools: names, files, failed }
      facetsCache.set(message, facets)
      return facets as { tools: string[]; files: string[]; failed: boolean }
    },
    [facetsCache],
  )
  return { extractSearchText, extractFacets }
}
