import type { Message as WireMessage, NormalizedMessage, RenderableMessage } from '../../engine/message-shapes/message.js'
import type { Tools } from '../../tools/kit/tool.js'
import type { TranscriptAnchor } from '../messages/transcriptMemory.js'
import { buildMessageLookups } from '../../engine/messages/lookups.js'
import { reorderMessagesInUI } from './chatRowOrder.js'
import { deriveUUID } from '../../engine/message-shapes/identity.js'
import { findLastFoldBoundaryIndex, shouldShowUserMessage } from '../../engine/messages/messages.js'
import type { StreamingToolUse } from './streamToScreen.js'
import { applyGrouping } from '../messages/groupToolUses.js'
import { collapseReadSearchGroups } from '../messages/collapseReadSearch.js'
import { foldShellNotices } from './foldShellNotices.js'
import { injectTurnReceipts } from '../cockpit/turnReceipt.js'
import { getMercuryTempDir } from '../../permissions/rules/filesystem.js'
import { isNullRenderingAttachment, isNullRenderingSystemRow } from '../messages/nullRenderingAttachments.js'

const RENDER_CAP = 200
const RENDER_CAP_STEP = 50
const TRANSCRIPT_TRUNCATE = 30
export const LIVE_REASONING_LINGER_MS = 30_000
export const EMPTY_ROWS: readonly WireMessage[] = []
export const EMPTY_NORMALIZED: NormalizedMessage[] = []
export const EMPTY_SYNTHETIC: Array<{ streaming: StreamingToolUse; uuid: ReturnType<typeof deriveUUID> }> = []
export const EMPTY_COMPOSITION: TranscriptComposition = { collapsed: [], lookups: buildMessageLookups([], []), truncated: false, hiddenCount: 0 }

type SliceAnchor = TranscriptAnchor

const isFoldRow = (message: RenderableMessage): boolean =>
  message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary'

export function computeSliceStart(
  collapsed: RenderableMessage[],
  anchorRef: { current: SliceAnchor },
  cap: number = RENDER_CAP,
  step: number = RENDER_CAP_STEP,
): number {
  const anchor = anchorRef.current
  const folds = collapsed.reduce((count, message) => count + (isFoldRow(message) ? 1 : 0), 0)
  let start = 0
  if (anchor !== null) {
    const found = collapsed.findIndex(message => message.uuid === anchor.uuid)
    if (folds > (anchor.folds ?? folds)) {
      start = collapsed.findLastIndex(isFoldRow)
    } else if (found !== -1) {
      start = found
    } else {
      start = Math.min(anchor.idx, Math.max(0, collapsed.length - 1))
    }
  }
  if (collapsed.length - start > cap + step) {
    start = collapsed.length - cap
  }
  const at = collapsed[start]
  anchorRef.current = at ? { uuid: at.uuid, idx: start, folds } : null
  return start
}


const SAME_ROW_DEPTH = 3

function sameValue(a: unknown, b: unknown, depth: number): boolean {
  if (a === b) return true
  if (depth === 0 || a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i], depth - 1)) return false
    return true
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false
    if (!sameValue(left[key], right[key], depth - 1)) return false
  }
  return true
}

export function reuseSettledRows(
  previous: readonly RenderableMessage[],
  next: RenderableMessage[],
): RenderableMessage[] {
  if (previous.length === 0) return next
  const before = new Map<string, RenderableMessage>()
  for (const row of previous) before.set(row.uuid, row)
  let reused = false
  const out = next.map(row => {
    const prior = before.get(row.uuid)
    if (prior === undefined || prior === row || !sameValue(prior, row, SAME_ROW_DEPTH)) return row
    reused = true
    return prior
  })
  return reused ? out : next
}

export function isAssistantContinuationRow(
  messages: RenderableMessage[],
  index: number,
): boolean {
  if (index <= 0 || index >= messages.length) return false
  const current = messages[index]!
  const previous = messages[index - 1]!

  const agentSide = (m: RenderableMessage): boolean =>
    m.type === 'assistant' ||
    m.type === 'grouped_tool_use' ||
    m.type === 'collapsed_read_search'

  const stamps = (m: RenderableMessage): boolean => {
    if (m.type === 'grouped_tool_use' || m.type === 'collapsed_read_search') {
      return true
    }
    if (m.type !== 'assistant') return false
    const content = Array.isArray(m.message.content) ? m.message.content : []
    const first = content[0]
    if (!first) return false
    return first.type !== 'thinking' && first.type !== 'redacted_thinking'
  }

  return agentSide(current) && agentSide(previous) && stamps(previous)
}

type TranscriptComposition = {
  collapsed: RenderableMessage[]
  lookups: ReturnType<typeof buildMessageLookups>
  truncated: boolean
  hiddenCount: number
}

export function composeTranscript(input: {
  normalized: NormalizedMessage[]
  syntheticStreamingRows: Array<{ streaming: StreamingToolUse; uuid: ReturnType<typeof deriveUUID> }>
  verbose: boolean
  fullscreen: boolean
  isTranscriptMode: boolean
  truncateTranscript: boolean
  tools: Tools
  inProgressToolUseIDs: Set<string>
}): TranscriptComposition {
  const { normalized, syntheticStreamingRows, verbose, fullscreen, isTranscriptMode, truncateTranscript, tools, inProgressToolUseIDs } = input
  let working: NormalizedMessage[] = normalized
  if (!verbose && !fullscreen) {
    const boundary = findLastFoldBoundaryIndex(working)
    if (boundary > 0) {
      working = working.filter(
        (message, index) =>
          index >= boundary ||
          (message as { isSnipped?: boolean }).isSnipped === true,
      )
    }
  }

  working = working.filter(message => {
    if (message.type === 'progress') return false
    if (message.type === 'attachment' && isNullRenderingAttachment(message)) {
      return false
    }
    if (message.type === 'system' && isNullRenderingSystemRow(message)) {
      return false
    }
    if (
      message.type === 'user' &&
      !shouldShowUserMessage(message, isTranscriptMode)
    ) {
      return false
    }
    return true
  })

  const synthetic: NormalizedMessage[] = syntheticStreamingRows.map(
    ({ streaming, uuid }) => ({
      type: 'assistant',
      uuid,
      timestamp: new Date().toISOString(),
      requestId: undefined,
      isVirtual: true,
      message: {
        id: uuid,
        container: null,
        role: 'assistant',
        type: 'message',
        model: '<streaming>',
        content: [streaming.contentBlock],
        stop_reason: null,
        stop_sequence: null,
        context_management: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation: null,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          inference_geo: null,
          iterations: null,
          output_tokens_details: null,
          server_tool_use: null,
          service_tier: null,
          speed: null,
        },
      },
    }),
  )
  working = reorderMessagesInUI(
    working as Parameters<typeof reorderMessagesInUI>[0],
    synthetic as Parameters<typeof reorderMessagesInUI>[1],
  ) as typeof working

  let truncated = false
  let hiddenCount = 0
  if (truncateTranscript) {
    truncated = working.length > TRANSCRIPT_TRUNCATE
    hiddenCount = working.length - TRANSCRIPT_TRUNCATE
    if (truncated) {
      working = working.slice(-TRANSCRIPT_TRUNCATE)
    }
  }
  const postTruncation = working

  let collapsed: RenderableMessage[] = applyGrouping(
    postTruncation as Parameters<typeof applyGrouping>[0],
    tools,
    verbose,
  ).messages as RenderableMessage[]
  collapsed = injectTurnReceipts(collapsed, getMercuryTempDir())
  collapsed = collapseReadSearchGroups(
    collapsed as Parameters<typeof collapseReadSearchGroups>[0],
    tools,
    inProgressToolUseIDs,
  ) as RenderableMessage[]
  collapsed = foldShellNotices(
    collapsed as Parameters<typeof foldShellNotices>[0],
    verbose,
  ) as RenderableMessage[]

  const lookups = buildMessageLookups(
    normalized,
    postTruncation as Parameters<typeof buildMessageLookups>[1],
  )

  return { collapsed, lookups, truncated, hiddenCount }
}
