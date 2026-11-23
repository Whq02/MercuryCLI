import { useMemo, useRef } from 'react'
import type { Message as WireMessage, RenderableMessage } from '../../engine/message-shapes/message.js'
import { getToolUseID } from '../../engine/messages/lookups.js'
import { normalizeMessages } from '../../engine/message-shapes/normalize.js'
import { isNotEmptyMessage } from '../../engine/message-shapes/text.js'
import { deriveUUID } from '../../engine/message-shapes/identity.js'
import { EMPTY_SYNTHETIC, EMPTY_ROWS, composeTranscript, reuseSettledRows, EMPTY_NORMALIZED, EMPTY_COMPOSITION } from './transcript.js'
import type { MessagesProps } from './shapes.js'

export function useTranscriptRows({ fullscreen, inProgressToolUseIDs, isTranscriptMode, messages, showAllInTranscript, streamingToolUses, tailAnchor, tools, verbose, virtualised }: { fullscreen: boolean; inProgressToolUseIDs: MessagesProps['inProgressToolUseIDs']; isTranscriptMode: boolean; messages: MessagesProps['messages']; showAllInTranscript: Exclude<MessagesProps['showAllInTranscript'], undefined>; streamingToolUses: MessagesProps['streamingToolUses']; tailAnchor: MessagesProps['tailAnchor']; tools: MessagesProps['tools']; verbose: MessagesProps['verbose']; virtualised: boolean }) {
  const anchor = tailAnchor === undefined ? messages.length : Math.min(Math.max(0, tailAnchor), messages.length)
  const [beforeTail, afterTail] = useMemo(
    (): [readonly WireMessage[], readonly WireMessage[]] =>
      anchor >= messages.length ? [messages, EMPTY_ROWS] : [messages.slice(0, anchor), messages.slice(anchor)],
    [messages, anchor],
  )

  const normalized = useMemo(
    () => normalizeMessages(beforeTail as WireMessage[]).filter(isNotEmptyMessage),
    [beforeTail],
  )
  const normalizedAfter = useMemo(
    () => (afterTail.length === 0 ? EMPTY_NORMALIZED : normalizeMessages(afterTail as WireMessage[]).filter(isNotEmptyMessage)),
    [afterTail],
  )

  const syntheticStreamingRows = useMemo(() => {
    const known = new Set<string>()
    for (const message of normalized) {
      const id = getToolUseID(message)
      if (id != null) known.add(id)
    }
    return streamingToolUses
      .filter(
        streaming =>
          !known.has(streaming.contentBlock.id) &&
          !inProgressToolUseIDs.has(streaming.contentBlock.id),
      )
      .map((streaming, index) => ({
        streaming,
        uuid: deriveUUID(
          streaming.contentBlock.id.padEnd(24, '0').slice(0, 24) as Parameters<typeof deriveUUID>[0],
          index,
        ),
      }))
  }, [streamingToolUses, normalized, inProgressToolUseIDs])

  const truncateTranscript =
    isTranscriptMode && !showAllInTranscript && !virtualised

  const derived = useMemo(
    () => composeTranscript({ normalized, syntheticStreamingRows, verbose, fullscreen, isTranscriptMode, truncateTranscript, tools, inProgressToolUseIDs }),
    [verbose, normalized, isTranscriptMode, syntheticStreamingRows, truncateTranscript, tools, fullscreen, inProgressToolUseIDs],
  )
  const derivedAfter = useMemo(
    () =>
      normalizedAfter.length === 0
        ? EMPTY_COMPOSITION
        : composeTranscript({ normalized: normalizedAfter, syntheticStreamingRows: EMPTY_SYNTHETIC, verbose, fullscreen, isTranscriptMode, truncateTranscript: false, tools, inProgressToolUseIDs }),
    [verbose, normalizedAfter, isTranscriptMode, tools, fullscreen, inProgressToolUseIDs],
  )
  const { lookups, truncated, hiddenCount } = derived
  const settledRowsRef = useRef<{ before: RenderableMessage[]; after: RenderableMessage[] }>({ before: [], after: [] })
  const collapsed = useMemo(() => reuseSettledRows(settledRowsRef.current.before, derived.collapsed), [derived])
  const afterRows = useMemo(() => reuseSettledRows(settledRowsRef.current.after, derivedAfter.collapsed), [derivedAfter])
  settledRowsRef.current = { before: collapsed, after: afterRows }
  return { lookups, truncated, hiddenCount, collapsed, afterRows }
}
