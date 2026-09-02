// The transcript pipeline. Correctness here is identity stability and
// the static-vs-dynamic decisions, not pixels: stages 2–9 run in ONE memo,
// the render-range slice is a separate cheap memo so scrolling never re-runs
// the transforms, synthetic streaming rows derive their uuids from the
// tool-call id, and the header memoises on exactly two inputs so a new
// message array can never dirty it.

import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { Box, Text } from '../ink.js'
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import type { Screen } from '../screens/REPL.js'
import type {
  Message as WireMessage,
  NormalizedMessage,
  RenderableMessage,
  UserMessage,
} from '../types/message.js'
import type { Tools } from '../Tool.js'
import type { Command } from '../commands.js'
import type { AgentDefinitionsResult } from '../tools/AgentTool/loadAgentsDir.js'
import { AGENT_TOOL_NAME, LEGACY_AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js'
import { hiddenAgentToolUses } from '../tools/AgentTool/UI.js'
import {
  buildMessageLookups,
  EMPTY_STRING_SET,
  getToolUseID,
} from '../utils/messages/lookups.js'
import { normalizeMessages } from '../utils/messages/normalize.js'
import { isNotEmptyMessage } from '../utils/messages/text.js'
import { reorderMessagesInUI } from '../utils/messages/uiOrder.js'
import {
  dropTextInBriefTurns,
  filterForBriefTool,
} from '../utils/messages/briefFilters.js'
import { deriveUUID } from '../utils/messages/identity.js'
import {
  findLastCompactBoundaryIndex,
  shouldShowUserMessage,
} from '../utils/messages.js'
import { computeTailRelease } from '../utils/messages/tailRetirement.js'
import type {
  StreamingThinking,
  StreamingToolUse,
} from '../utils/messages/streaming.js'
import type { StreamingTailStore } from '../utils/messages/streamingTailStore.js'
import { applyGrouping } from '../utils/groupToolUses.js'
import { collapseReadSearchGroups } from '../utils/collapseReadSearch.js'
import { SentryErrorBoundary } from './SentryErrorBoundary.js'
import { collapseTeammateShutdowns } from '../utils/collapseTeammateShutdowns.js'
import { collapseHookSummaries } from '../utils/collapseHookSummaries.js'
import { collapseBackgroundBashNotifications } from '../utils/collapseBackgroundBashNotifications.js'
import { injectTurnReceipts, isTurnBoundary } from '../utils/cockpit/turnReceipt.js'
import { hasRealConversation as computeHasRealConversation } from '../utils/cockpit/realConversation.js'
import {
  renderableSearchText,
  toolResultSearchText,
  toolInputFiles,
  EMPTY_FACETS,
} from '../utils/transcriptSearch.js'
import { isNullRenderingAttachment } from './messages/nullRenderingAttachments.js'
import {
  BRIEF_TOOL_NAME,
  LEGACY_BRIEF_TOOL_NAME,
} from '../tools/BriefTool/prompt.js'
import { SEND_USER_FILE_TOOL_NAME } from '../tools/SendUserFileTool/prompt.js'
import { scribeChatroomEnabled, scribeModeEnabled } from '../utils/scribe/scribeGates.js'
import { isScribeModeOn } from '../utils/scribeMode.js'
import { classifyAuthor } from './mercury-ui/scribeChatTabs.js'
import { cockpitEngine } from '../render-engine/cockpit/engineMount.js'
import { termWrite } from '../render-engine/cockpit/terminalOut.js'
import { isFullscreenActive, isFullscreenEnvEnabled } from '../utils/fullscreen.js'
import { resolveTerminalExperience } from '../ink/session/terminalExperience.js'
import { getGlobalConfig } from '../utils/config.js'
import { getIsRemoteMode } from '../bootstrap/state.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import {
  OSC,
  OSC_PREFIX,
  PROGRESS,
  ST,
  wrapForMultiplexer,
} from '../ink/termio/osc.js'
import type {
  MessageActionsNav,
  MessageActionsState,
} from './messageActions.js'
import { InVirtualListContext } from './messageActions.js'
import { NameplateContinuationContext } from './messages/TranscriptNameplate.js'
import { AssistantThinkingMessage } from './messages/AssistantThinkingMessage.js'
import { LiveStreamingTail } from './LiveStreamingTail.js'
import { MercuryBrandRow, MercuryHero, MercuryHome } from './MercuryHome.js'
import { VirtualMessageList } from './VirtualMessageList.js'
import type { JumpHandle } from './VirtualMessageList.js'
import type { DOMElement } from '../ink.js'
import type { SearchPositionsState } from '../ink/hooks/use-search-highlight.js'
import type { MatchPosition } from '../ink/render-to-screen.js'
type UnseenDivider = { firstUnseenUuid: string; count: number }
import { findToolByName } from '../Tool.js'
import {
  allToolsResolved,
  hasContentAfterIndex,
  MessageRow,
} from './MessageRow.js'
import { OffscreenFreeze } from './OffscreenFreeze.js'
import { StatusNotices } from './StatusNotices.js'
import { CockpitActiveContext } from '../context/cockpitActiveContext.js'
import { fluxMark } from '../utils/flux/fluxProbe.js'

const RENDER_CAP = 200
const RENDER_CAP_STEP = 50
const TRANSCRIPT_TRUNCATE = 30
const LIVE_REASONING_LINGER_MS = 30_000

export type SliceAnchor = { uuid: string; idx: number } | null

/** The slice start: a uuid anchor plus a stored index, never a count-derived
 * offset (a "last N" window repaints the whole terminal per turn). */
export function computeSliceStart(
  collapsed: RenderableMessage[],
  anchorRef: { current: SliceAnchor },
  cap: number = RENDER_CAP,
  step: number = RENDER_CAP_STEP,
): number {
  const anchor = anchorRef.current
  let start = 0
  if (anchor !== null) {
    const found = collapsed.findIndex(message => message.uuid === anchor.uuid)
    if (found !== -1) {
      start = found
    } else {
      // Collapse regrouping can change derived uuids: fall back to the
      // stored index, clamped to a valid position. Never BELOW the stored
      // index: widening the window backward re-enters rows the inline
      // canvas already ceded to terminal scrollback, and the growth pass
      // would push copies of them into history (print-once re-entry).
      start = Math.min(anchor.idx, Math.max(0, collapsed.length - 1))
    }
  }
  // Advance only when the rendered count exceeds cap + step.
  if (collapsed.length - start > cap + step) {
    start = collapsed.length - cap
  }
  // Refresh the anchor from whatever now sits at the start.
  const at = collapsed[start]
  anchorRef.current = at ? { uuid: at.uuid, idx: start } : null
  return start
}

export { shouldRenderStatically } from './MessageRow.js'

/** Nameplate continuation: stamped once at the turn head, suppressed
 *  on continuations — but only when the previous row actually stamped. */
export function isAssistantContinuationRow(
  messages: RenderableMessage[],
  index: number,
  chatroomActive: boolean,
): boolean {
  if (index <= 0) return false
  const current = messages[index]!
  const previous = messages[index - 1]!

  const agentSide = (m: RenderableMessage): boolean =>
    m.type === 'assistant' ||
    m.type === 'grouped_tool_use' ||
    m.type === 'collapsed_read_search'

  const stamps = (m: RenderableMessage): boolean => {
    // A reasoning-opening row carries NO nameplate of its own; counting it
    // as "already stamped" would strip the turn's only nameplate.
    if (m.type === 'grouped_tool_use' || m.type === 'collapsed_read_search') {
      return true
    }
    if (m.type !== 'assistant') return false
    const content = Array.isArray(m.message.content) ? m.message.content : []
    const first = content[0]
    if (!first) return false
    return first.type !== 'thinking' && first.type !== 'redacted_thinking'
  }

  if (!chatroomActive) {
    return agentSide(current) && agentSide(previous) && stamps(previous)
  }
  if (!stamps(previous)) return false
  return (
    classifyAuthor(previous as Parameters<typeof classifyAuthor>[0]) ===
    classifyAuthor(current as Parameters<typeof classifyAuthor>[0])
  )
}

type MessagesProps = {
  messages: WireMessage[]
  tools: Tools
  commands: Command[]
  verbose: boolean
  toolJSX: { jsx: React.ReactNode | null; shouldHidePromptInput: boolean } | null
  toolUseConfirmQueue: unknown[]
  inProgressToolUseIDs: Set<string>
  isMessageSelectorVisible: boolean
  conversationId: string
  screen: Screen
  streamingToolUses: StreamingToolUse[]
  showAllInTranscript?: boolean
  agentDefinitions?: AgentDefinitionsResult
  suppressLogo?: boolean
  isLoading: boolean
  streamingThinking?: StreamingThinking | null
  hidePastReasoning?: boolean
  streamingTail?: StreamingTailStore | null
  /** The reveal is suppressed on this surface (streamingRevealSuppressed):
   *  the tail's TEXT half never paints, but the tail still mounts for the
   *  one quiet-stream 'thinking' line the settled rows suppress on every
   *  surface — the two halves of that feature share one gate (FN-016 R12). */
  streamingTextSuppressed?: boolean
  isBriefOnly?: boolean
  unseenDivider?: UnseenDivider
  scrollRef?: React.RefObject<ScrollBoxHandle | null>
  trackStickyPrompt?: boolean
  jumpRef?: React.Ref<JumpHandle | null>
  onSearchMatchesChange?: (total: number, current: number) => void
  scanElement?: (el: DOMElement) => MatchPosition[]
  setPositions?: (state: SearchPositionsState | null) => void
  disableRenderCap?: boolean
  cursor?: MessageActionsState | null
  setCursor?: (cursor: MessageActionsState | null) => void
  cursorNavRef?: React.MutableRefObject<MessageActionsNav | null>
  renderRange?: readonly [number, number]
}

function MessagesInner({
  messages,
  tools,
  commands,
  verbose,
  toolJSX,
  toolUseConfirmQueue,
  inProgressToolUseIDs,
  isMessageSelectorVisible,
  conversationId,
  screen,
  streamingToolUses,
  showAllInTranscript = false,
  agentDefinitions,
  suppressLogo = false,
  isLoading,
  streamingThinking = null,
  hidePastReasoning = false,
  streamingTail = null,
  streamingTextSuppressed = false,
  isBriefOnly = false,
  unseenDivider,
  scrollRef,
  trackStickyPrompt = false,
  jumpRef,
  onSearchMatchesChange,
  scanElement,
  setPositions,
  disableRenderCap = false,
  cursor,
  setCursor,
  cursorNavRef,
  renderRange,
}: MessagesProps): React.ReactNode {
  // The transcript's render mark on the FLUX probe ring (MERCURY_FLUX_PROBE
  // only; off ⇒ no-op): the region-invalidation matrix reads the messages
  // region's rhythm from it — a keystroke never re-renders the transcript.
  fluxMark('render:messages')
  const { columns } = useTerminalSize()
  const isTranscriptMode = screen === 'transcript'
  const fullscreen = isFullscreenEnvEnabled()
  const inCockpit = React.useContext(CockpitActiveContext)

  // Virtualisation is decided ONCE at mount — this component re-renders on
  // every scroll.
  const [virtualEffective] = useState(
    () => resolveTerminalExperience().virtualScroll.effective,
  )
  // Virtual windowing is an ALT-SCREEN instrument: its spacer/range
  // re-derivation moves content between frame coordinates, which the
  // fullscreen scroll container clips harmlessly. On the MAIN screen
  // (inline mode) rows above the viewport are CEDED to terminal scrollback
  // — print-once, frozen — and a window slide there re-enters already-ceded
  // rows into the composed frame, which the growth pass then pushes into
  // history AGAIN (one whole-block copy per slide: the ×2…×6 duplication).
  // Inline therefore always composes append-only (native scrollback is the
  // scroll experience) and never windows.
  const virtualised = Boolean(scrollRef) && virtualEffective && isFullscreenActive()

  // ── stage 1: normalise + drop empties (its own memo) ────────────────────
  const normalized = useMemo(
    () => normalizeMessages(messages).filter(isNotEmptyMessage),
    [messages],
  )

  // Streaming tool-call synthesis: deterministic uuids from the tool-call
  // id — a random identity would remount the subtree mid-stream and paint
  // duplicated text.
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

  // ── stages 2–9: one memo ────────────────────────────────────────────────
  const derived = useMemo(() => {
    // Stage 2: boundary filter (fullscreen keeps everything — there is no
    // native scrollback above the viewport there).
    let working: NormalizedMessage[] = normalized
    if (!verbose && !fullscreen) {
      const boundary = findLastCompactBoundaryIndex(working)
      if (boundary > 0) {
        working = working.filter(
          (message, index) =>
            index >= boundary ||
            (message as { isSnipped?: boolean }).isSnipped === true,
        )
      }
    }

    // Stage 3: drop hidden rows BEFORE counting or slicing.
    working = working.filter(message => {
      if (message.type === 'progress') return false
      if (message.type === 'attachment' && isNullRenderingAttachment(message)) {
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

    // Stage 4: display order, merging in the synthetic streaming rows.
    // The in-flight tool call painted as a normal assistant row: a
    // fully-formed normalized message, never a partial one widened by a
    // cast (the renderer reads timestamp, usage and stop fields).
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

    // Stage 5: brief-mode tiers (skipped without the brief tool names).
    const preBriefLength = working.length
    // The brief family: the brief tool (both spellings) and the file-send tool.
    const briefToolNames = [BRIEF_TOOL_NAME, LEGACY_BRIEF_TOOL_NAME, SEND_USER_FILE_TOOL_NAME].filter(
      name => findToolByName(tools, name) !== undefined,
    )
    if (briefToolNames.length > 0) {
      if (isTranscriptMode) {
        // Unfiltered.
      } else if (isBriefOnly) {
        working = filterForBriefTool(
          working as Parameters<typeof filterForBriefTool>[0],
          briefToolNames,
        ) as typeof working
      } else {
        // All three: the scribe-mode flag, the mode actually on, the chat-room flag.
        const chatroomEngaged = scribeModeEnabled() && isScribeModeOn() && scribeChatroomEnabled()
        if (!chatroomEngaged) {
          working = dropTextInBriefTurns(
            working as Parameters<typeof dropTextInBriefTurns>[0],
            briefToolNames,
          ) as typeof working
        }
      }
    }

    // Stage 6: transcript truncation.
    let truncated = false
    let hiddenCount = 0
    if (truncateTranscript) {
      truncated = working.length > TRANSCRIPT_TRUNCATE
      hiddenCount = preBriefLength - TRANSCRIPT_TRUNCATE
      if (truncated) {
        working = working.slice(-TRANSCRIPT_TRUNCATE)
      }
    }
    const postTruncation = working

    // Stages 7–8: group, then inject receipts, then collapse (in order).
    let collapsed: RenderableMessage[] = applyGrouping(
      postTruncation as Parameters<typeof applyGrouping>[0],
      tools,
      verbose,
    ).messages as RenderableMessage[]
    collapsed = injectTurnReceipts(collapsed)
    collapsed = collapseReadSearchGroups(
      collapsed as Parameters<typeof collapseReadSearchGroups>[0],
      tools,
      inProgressToolUseIDs,
    ) as RenderableMessage[]
    collapsed = collapseTeammateShutdowns(
      collapsed as Parameters<typeof collapseTeammateShutdowns>[0],
    ) as RenderableMessage[]
    collapsed = collapseHookSummaries(
      collapsed as Parameters<typeof collapseHookSummaries>[0],
    ) as RenderableMessage[]
    collapsed = collapseBackgroundBashNotifications(
      collapsed as Parameters<typeof collapseBackgroundBashNotifications>[0],
      verbose,
    ) as RenderableMessage[]

    // Stage 9: lookups over the FULL normalised array plus the
    // post-truncation pre-grouping array, so grouped-away calls still
    // resolve.
    const lookups = buildMessageLookups(
      normalized,
      postTruncation as Parameters<typeof buildMessageLookups>[1],
    )

    return { collapsed, lookups, truncated, hiddenCount }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed
  }, [
    verbose,
    normalized,
    isTranscriptMode,
    syntheticStreamingRows,
    truncateTranscript,
    tools,
    isBriefOnly,
    fullscreen,
    // The running-card law: a collapse-eligible tool use in progress stays a
    // real row, so the pipe re-folds when the in-progress set moves.
    inProgressToolUseIDs,
  ])

  const { collapsed, lookups, truncated, hiddenCount } = derived

  // THE SETTLED-ROW LEDGER FEED (engine laws E1/E2/E10, engine-mounted
  // only): every committed projection walks into the CockpitLedger — the
  // stable prefix (whole settled turns behind the live edge, receipts as
  // boundaries) freezes as ordered batches, identity-deduped, and the
  // frozen prefix is re-verified against the projection each commit (the
  // continuous agreement assertion; loud under MERCURY_ENGINE_ASSERT).
  const engineForLedger = cockpitEngine()
  useEffect(() => {
    if (engineForLedger === null) return
    engineForLedger.ledger.feed(
      collapsed.map(message => ({
        uuid: message.uuid,
        kind: message.type,
        turnHead: isTurnBoundary(message as Parameters<typeof isTurnBoundary>[0]),
        text: renderableSearchText(
          message as Parameters<typeof renderableSearchText>[0],
        ),
      })),
    )
  }, [engineForLedger, collapsed])

  // ── render cap / range slice (separate, cheap memo) ─────────────────────
  const anchorRef = useRef<SliceAnchor>(null)
  const visible = useMemo(() => {
    if (renderRange) {
      return collapsed.slice(renderRange[0], renderRange[1])
    }
    if (virtualised || disableRenderCap) return collapsed
    const start = computeSliceStart(collapsed, anchorRef)
    return start > 0 ? collapsed.slice(start) : collapsed
  }, [collapsed, virtualised, disableRenderCap, renderRange])

  // ── derived state ───────────────────────────────────────────────────────
  const lastThinkingBlockId = useMemo(() => {
    if (!hidePastReasoning) return null
    if (streamingThinking?.isStreaming) return 'streaming-sentinel'
    for (let i = collapsed.length - 1; i >= 0; i--) {
      const message = collapsed[i]!
      if (message.type === 'user') {
        const content = message.message.content
        const isToolResultRow =
          Array.isArray(content) &&
          content.some(block => block.type === 'tool_result')
        if (!isToolResultRow) return 'no-thinking-sentinel'
        continue
      }
      if (message.type !== 'assistant') continue
      const content = Array.isArray(message.message.content)
        ? message.message.content
        : []
      for (let b = content.length - 1; b >= 0; b--) {
        if (content[b]!.type === 'thinking') {
          return `${message.uuid}:${b}`
        }
      }
    }
    return 'no-thinking-sentinel'
  }, [hidePastReasoning, collapsed, streamingThinking?.isStreaming])

  const liveReasoningVisible =
    streamingThinking !== null &&
    (streamingThinking.isStreaming ||
      (streamingThinking.streamingEndedAt !== undefined &&
        Date.now() - streamingThinking.streamingEndedAt <
          LIVE_REASONING_LINGER_MS))

  const latestBashOutputUUID = useMemo(() => {
    for (let i = collapsed.length - 1; i >= 0; i--) {
      const message = collapsed[i]!
      if (message.type !== 'user') continue
      const content = message.message.content
      if (!Array.isArray(content)) continue
      const isShell = content.some(
        block =>
          block.type === 'text' &&
          (block.text.startsWith('<bash-stdout') ||
            block.text.startsWith('<bash-stderr')),
      )
      if (isShell) return message.uuid
    }
    return null
  }, [collapsed])

  const hasRealConversation = useMemo(
    () =>
      computeHasRealConversation(
        collapsed as Parameters<typeof computeHasRealConversation>[0],
      ),
    [collapsed],
  )

  // ── click-to-expand ─────────────────────────────────────────────────────
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  )
  const expansionKeyOf = useCallback((msg: RenderableMessage): string => {
    if (
      msg.type !== 'grouped_tool_use' &&
      msg.type !== 'collapsed_read_search' &&
      msg.type !== 'turn_receipt'
    ) {
      return getToolUseID(msg as NormalizedMessage) ?? msg.uuid
    }
    return msg.uuid
  }, [])

  const isItemExpanded = useCallback(
    (msg: RenderableMessage): boolean => expandedKeys.has(expansionKeyOf(msg)),
    [expandedKeys, expansionKeyOf],
  )

  const lookupsRef = useRef(lookups)
  lookupsRef.current = lookups
  const errorFoldCache = useRef(new WeakMap<object, boolean>())

  // Agent-card fold honesty: the ⌄ cue may only arm when the fold actually
  // HIDES work — a dead click on a fully-shown card is banned.
  const isAgentToolName = useCallback(
    (name?: string): boolean =>
      name === AGENT_TOOL_NAME || name === LEGACY_AGENT_TOOL_NAME,
    [],
  )
  const agentFoldHidden = useCallback(
    (toolUseID: string): boolean => {
      const progress =
        lookupsRef.current.progressMessagesByToolUseID.get(toolUseID) ?? []
      return hiddenAgentToolUses(progress, tools) > 0
    },
    [tools],
  )

  const isItemClickable = useCallback(
    (message: RenderableMessage): boolean => {
      if (message.type === 'collapsed_read_search') return true
      const live = lookupsRef.current
      if (message.type === 'assistant') {
        const content = Array.isArray(message.message.content)
          ? message.message.content
          : []
        const first = content[0]
        if (first?.type === 'thinking') {
          return (
            !verbose && typeof first.thinking === 'string' &&
            first.thinking.trim().length > 0
          )
        }
        if (first?.type === 'advisor_tool_result') return true
        if (
          !verbose &&
          first?.type === 'tool_use' && isAgentToolName(first.name) &&
          agentFoldHidden((first as { id: string }).id)
        ) {
          return true
        }
        return false
      }
      if (message.type === 'user') {
        const content = message.message.content
        if (!Array.isArray(content)) return false
        const result = content.find(block => block.type === 'tool_result')
        if (!result) return false
        const b_0 = result as { tool_use_id: string }
        if (
          !verbose &&
          isAgentToolName(lookupsRef.current.toolUseByToolUseID.get(b_0.tool_use_id)?.name) &&
          agentFoldHidden(b_0.tool_use_id)
        ) {
          return true
        }
        const cached = errorFoldCache.current.get(message)
        if (cached !== undefined) return cached
        const id = (result as { tool_use_id?: string }).tool_use_id
        const toolUse = id ? live.toolUseByToolUseID.get(id) : undefined
        const tool = toolUse ? findToolByName(tools, toolUse.name) : undefined
        const record = (message as { toolUseResult?: unknown }).toolUseResult
        let verdict = false
        if ((result as { is_error?: boolean }).is_error) {
          verdict = true
        } else if (record !== undefined && tool) {
          verdict =
            (
              tool as {
                isResultTruncated?: (result: unknown) => boolean
              }
            ).isResultTruncated?.(record) === true
        }
        errorFoldCache.current.set(message, verdict)
        return verdict
      }
      return false
  }, [tools, verbose, isAgentToolName, agentFoldHidden]);

  // ── animation permission (caller-level) ─────────────────────────────────
  const canAnimate =
    !(
      toolJSX !== null &&
      !(toolJSX as { continueAnimation?: boolean }).continueAnimation
    ) &&
    toolUseConfirmQueue.length === 0 &&
    !isMessageSelectorVisible

  const onItemClick = useCallback(
    (message: RenderableMessage) => {
      const key = expansionKeyOf(message)
      setExpandedKeys(previous => {
        const next = new Set(previous)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
    },
    [expansionKeyOf],
  )

  // ── search indexing (cached per message object) ─────────────────────────
  const searchTextCache = useRef(new WeakMap<object, string>())
  const extractSearchText = useCallback(
    (message: RenderableMessage): string => {
      const cached = searchTextCache.current.get(message)
      if (cached !== undefined) return cached
      const lowered = renderableSearchText(
        message as Parameters<typeof renderableSearchText>[0],
      ).toLowerCase()
      searchTextCache.current.set(message, lowered)
      return lowered
    },
    [tools],
  )

  // The facet cache regenerates whenever the LOOKUPS change: the failure
  // facet derives from sets still being filled after the row was created.
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

  // ── terminal progress reporting ─────────────────────────────────────────
  const lastProgressRef = useRef<string | null>(null)
  const progressEnabled =
    getGlobalConfig().terminalProgressBarEnabled !== false &&
    !getIsRemoteMode()
  useEffect(() => {
    if (!progressEnabled) return
    const state =
      inProgressToolUseIDs.size > 0 ? 'indeterminate' : 'completed'
    if (state === lastProgressRef.current) return
    lastProgressRef.current = state
    const code =
      state === 'indeterminate' ? PROGRESS.INDETERMINATE : PROGRESS.CLEAR
    termWrite(
      process.stdout,
      wrapForMultiplexer(`${OSC_PREFIX}${OSC.ITERM2};4;${code};0${ST}`),
      'mode',
    )
  }, [inProgressToolUseIDs, progressEnabled])
  useEffect(
    () => () => {
      if (lastProgressRef.current !== null && progressEnabled) {
        termWrite(
          process.stdout,
          wrapForMultiplexer(
            `${OSC_PREFIX}${OSC.ITERM2};4;${PROGRESS.CLEAR};0${ST}`,
          ),
          'mode',
        )
      }
    },
    [progressEnabled],
  )

  // ── header (memoised on its REAL inputs) ─────────────────────────────────
  const chatroomActive = isScribeModeOn() && scribeChatroomEnabled()
  const header = useMemo(() => {
    if (suppressLogo || renderRange) return null
    return (
      <OffscreenFreeze>
        <Box flexDirection="column" width="100%">
          {!inCockpit ? (
            columns >= 96 ? (
              <Box>
                <MercuryHero />
                <Box flexDirection="column" flexGrow={1}>
                  {hasRealConversation ? <MercuryBrandRow /> : null}
                </Box>
              </Box>
            ) : (
              <Box flexDirection="column">
                <MercuryHero />
                {hasRealConversation ? <MercuryBrandRow /> : null}
              </Box>
            )
          ) : null}
          {/* The LANDING card (empty transcript only): the session table
              (model · theme · realm) and the ↵-sends prompt-hint row. It
              collapses the moment a real conversation exists — the
              furniture-collapse law the model-switch render pins. */}
          {!hasRealConversation ? <MercuryHome /> : null}
          {/* The brand-to-transcript rule belongs to the STANDALONE header
              only — in the cockpit the hero/brand block sheds, and a rule
              with nothing above it painted as an orphaned separator
              (regression inventory). */}
          {/* Flush with the transcript rows below it — the 1-col inset left
              the structural rule ragged against the rows' left edge
              (PAINT-home-ragged-left-edge, 80-col home). */}
          {hasRealConversation && !inCockpit ? (
            <Box>
              <Text dimColor>{'─'.repeat(Math.max(8, Math.min(40, columns - 4)))}</Text>
            </Box>
          ) : null}
          {/* The startup notice strip. It suspends on the instruction-file
              read, so it hangs behind a null fallback: a pending read must
              not blank the header above it. */}
          <React.Suspense fallback={null}>
            <StatusNotices agentDefinitions={agentDefinitions} />
          </React.Suspense>
        </Box>
      </OffscreenFreeze>
    )
    // The dep list is the memo's REAL input set — the old two-input pin
    // froze columns (the rule's width never followed a resize) and
    // inCockpit (entering/leaving the cockpit kept the stale header until
    // an unrelated input changed).
  }, [agentDefinitions, hasRealConversation, inCockpit, columns, suppressLogo, renderRange])

  const transcriptChord = useShortcutDisplay(
    'transcript:toggleShowAll',
    'Transcript',
    'ctrl+e',
  )

  const itemKey = useCallback(
    (message: RenderableMessage) => `${message.uuid}:${conversationId}`,
    [conversationId],
  )

  const renderRow = useCallback(
    (msg_8: RenderableMessage, index: number): React.ReactNode => {
      const key = expansionKeyOf(msg_8)
      return (
        <NameplateContinuationContext.Provider
          value={isAssistantContinuationRow(visible, index, chatroomActive)}
        >
          {/* One row's render throw degrades to that row's fallback line
              (crash report retained) while the rest of the transcript and
              the session keep painting — the app-root boundary ends the
              process, and a transcript row is never worth the live view. */}
          <SentryErrorBoundary>
          <MessageRow
            message={msg_8}
            isUserContinuation={
              msg_8.type === 'user' && visible[index - 1]?.type === 'user'
            }
            hasContentAfter={
              msg_8.type === 'collapsed_read_search' &&
              (streamingTail !== null && !streamingTextSuppressed && isLoading
                ? true
                : hasContentAfterIndex(
                    visible,
                    index,
                    tools,
                    EMPTY_STRING_SET as Set<string>,
                  ))
            }
            tools={tools}
            commands={commands}
            verbose={verbose || isItemExpanded(msg_8)}
            inProgressToolUseIDs={inProgressToolUseIDs}
            streamingToolUseIDs={EMPTY_STRING_SET as Set<string>}
            screen={screen}
            canAnimate={canAnimate}
            lastThinkingBlockId={lastThinkingBlockId}
            latestBashOutputUUID={latestBashOutputUUID}
            columns={columns}
            isLoading={isLoading}
            lookups={lookups}
            conversationId={conversationId}
            isCursorRow={cursor?.uuid === msg_8.uuid}
            cursorExpanded={Boolean(
              cursor?.uuid === msg_8.uuid &&
                (cursor as { expanded?: boolean } | null)?.expanded,
            )}
            clickExpanded={expandedKeys.has(key)}
          />
          </SentryErrorBoundary>
        </NameplateContinuationContext.Provider>
      )
    },
    [
      visible,
      chatroomActive,
      tools,
      commands,
      verbose,
      inProgressToolUseIDs,
      screen,
      canAnimate,
      lastThinkingBlockId,
      latestBashOutputUUID,
      columns,
      isLoading,
      lookups,
      conversationId,
      cursor,
      expandedKeys,
      expansionKeyOf,
      isItemExpanded,
      streamingTail,
      streamingTextSuppressed,
    ],
  )

  // ── divider placement ───────────────────────────────────────────────────
  const dividerBeforeIndex = useMemo(() => {
    if (!unseenDivider) return -1
    const prefix = unseenDivider.firstUnseenUuid.slice(0, 24)
    return visible.findIndex(message => message.uuid.startsWith(prefix))
  }, [unseenDivider, visible])

  // The tail's release (the one law, computeTailRelease): a visible
  // assistant row of the CURRENT turn — every row since the last human
  // turn — retires the tail the moment it carries the tail's identity
  // (SessionTailV1.messageId through the store's id channel): the settled
  // ghost AND the published settle-class hold both. Where the tail has no
  // identity (an old runner's projection; the in-process fan-out) the
  // ghost falls back to the trimmed text match this block used to inline —
  // kept byte-identical, with its history: matching the LAST row alone
  // staggered a counting turn's ghosts, and unmatched raw whitespace stood
  // ghosts beside their own rows until the next delta. The identity law
  // exists because the daemon road can hold a watch-cadence PREFIX of the
  // block (never equal to its row), and held published text had no release
  // at all — the attach-road double paint.
  // Verdicts must be fresh at every tail BOUNDARY (first text · clear ·
  // next text), not only when the row list moves: a boundary can arrive on
  // a leaf-only publish (the FLUX design keeps per-delta renders out of
  // this tree), and a verdict computed for the previous boundary's subject
  // would hide the wrong text or stand a released ghost back up. The
  // snapshot key changes ONLY at boundaries — ids and the settled hold are
  // constant across growth deltas — so this subscription re-renders
  // Messages a handful of times per turn, never per delta.
  const subscribeTailBoundary = useCallback(
    (cb: () => void) => streamingTail?.subscribe(cb) ?? (() => {}),
    [streamingTail],
  )
  const readTailBoundaryKey = useCallback(() => {
    if (!streamingTail) return ''
    const ids = streamingTail.readIds()
    return `${ids.current ?? ''}\x00${ids.settled ?? ''}\x00${streamingTail.readSettled() ?? ''}`
  }, [streamingTail])
  const tailBoundaryKey = useSyncExternalStore(subscribeTailBoundary, readTailBoundaryKey)
  const { publishedShown, settledShown } = useMemo(() => {
    void tailBoundaryKey
    return computeTailRelease(
      visible as unknown as Parameters<typeof computeTailRelease>[0],
      streamingTail?.readIds() ?? { current: null, settled: null },
      streamingTail?.readSettled() ?? null,
    )
  }, [visible, streamingTail, tailBoundaryKey])

  const tail = (
    <>
      {/* Brief-only hides the live prose tail: the settled transcript keeps
          only the brief tool's message, so a tail that streamed and vanished
          would contradict it. */}
      {streamingTail && !isBriefOnly ? (
        <LiveStreamingTail
          store={streamingTail}
          settledShown={settledShown}
          publishedShown={publishedShown}
          textSuppressed={streamingTextSuppressed}
        />
      ) : null}
      {liveReasoningVisible && streamingThinking && !isBriefOnly ? (
        <AssistantThinkingMessage
          param={{ type: 'thinking', thinking: streamingThinking.thinking }}
          addMargin
          verbose={verbose}
        />
      ) : null}
    </>
  )

  if (virtualised && scrollRef) {
    return (
      <InVirtualListContext.Provider value={true}>
        <Box flexDirection="column" width="100%">
          {header}
          <VirtualMessageList
            messages={visible}
            scrollRef={scrollRef}
            columns={columns}
            itemKey={itemKey}
            renderItem={renderRow}
            onItemClick={onItemClick}
            isItemClickable={isItemClickable}
            isItemExpanded={(message: RenderableMessage) =>
              expandedKeys.has(expansionKeyOf(message))
            }
            extractSearchText={extractSearchText}
            extractFacets={extractFacets}
            trackStickyPrompt={trackStickyPrompt}
            selectedIndex={
              cursor
                ? visible.findIndex(message => message.uuid === cursor.uuid)
                : undefined
            }
            cursorNavRef={cursorNavRef}
            setCursor={setCursor}
            jumpRef={jumpRef}
            onSearchMatchesChange={onSearchMatchesChange}
            scanElement={scanElement}
            setPositions={setPositions}
          />
          {tail}
        </Box>
      </InVirtualListContext.Provider>
    )
  }

  return (
    <Box flexDirection="column" width="100%">
      {header}
      {truncated && hiddenCount > 0 ? (
        <Text dimColor>
          {hiddenCount} previous {hiddenCount === 1 ? 'message' : 'messages'}{' '}
          hidden — {transcriptChord} shows all
        </Text>
      ) : null}
      {isTranscriptMode && showAllInTranscript && !disableRenderCap ? (
        <Text dimColor>showing all — {transcriptChord} hides older rows</Text>
      ) : null}
      {visible.map((message, index) => (
        <React.Fragment key={itemKey(message)}>
          {index === dividerBeforeIndex && unseenDivider ? (
            <Text key={`divider-${unseenDivider.firstUnseenUuid}`} dimColor>
              {'─'.repeat(Math.max(4, Math.floor(columns / 3)))} {unseenDivider.count} new{' '}
              {'─'.repeat(Math.max(4, Math.floor(columns / 3)))}
            </Text>
          ) : null}
          {renderRow(message, index)}
        </React.Fragment>
      ))}
      {tail}
    </Box>
  )
}

/** Transcript-level comparator: ignores callback/ref/scroll plumbing;
 *  special-cases streaming tool calls (content-block identity pairwise), the
 *  in-flight set (membership), the divider (uuid+count) and the tool list
 *  (names pairwise). Reasoning-stream changes always re-render. */
function areMessagesPropsEqual(
  prev: MessagesProps,
  next: MessagesProps,
): boolean {
  if (prev.streamingThinking !== next.streamingThinking) return false
  if (prev.messages !== next.messages) return false
  if (prev.verbose !== next.verbose) return false
  if (prev.screen !== next.screen) return false
  if (prev.isLoading !== next.isLoading) return false
  if (prev.isBriefOnly !== next.isBriefOnly) return false
  if (prev.showAllInTranscript !== next.showAllInTranscript) return false
  if (prev.toolJSX !== next.toolJSX) return false
  if (prev.isMessageSelectorVisible !== next.isMessageSelectorVisible) {
    return false
  }
  if (prev.conversationId !== next.conversationId) return false
  if (prev.disableRenderCap !== next.disableRenderCap) return false
  if (prev.suppressLogo !== next.suppressLogo) return false
  if (prev.cursor !== next.cursor) return false
  if (prev.renderRange !== next.renderRange) return false
  if (prev.trackStickyPrompt !== next.trackStickyPrompt) return false
  if (prev.streamingTail !== next.streamingTail) return false
  if (prev.streamingTextSuppressed !== next.streamingTextSuppressed) return false
  if (prev.toolUseConfirmQueue.length !== next.toolUseConfirmQueue.length) {
    return false
  }
  if (prev.agentDefinitions !== next.agentDefinitions) return false
  // Streaming tool calls: content-block identity pairwise.
  if (prev.streamingToolUses.length !== next.streamingToolUses.length) {
    return false
  }
  for (let i = 0; i < prev.streamingToolUses.length; i++) {
    if (
      prev.streamingToolUses[i]!.contentBlock !==
      next.streamingToolUses[i]!.contentBlock
    ) {
      return false
    }
  }
  // In-flight ids: membership.
  if (prev.inProgressToolUseIDs.size !== next.inProgressToolUseIDs.size) {
    return false
  }
  for (const id of prev.inProgressToolUseIDs) {
    if (!next.inProgressToolUseIDs.has(id)) return false
  }
  // The divider: first-unseen uuid + count.
  if (
    prev.unseenDivider?.firstUnseenUuid !== next.unseenDivider?.firstUnseenUuid ||
    prev.unseenDivider?.count !== next.unseenDivider?.count
  ) {
    return false
  }
  // The tool list: names pairwise.
  if (prev.tools.length !== next.tools.length) return false
  for (let i = 0; i < prev.tools.length; i++) {
    if (prev.tools[i]!.name !== next.tools[i]!.name) return false
  }
  return true
}

export const Messages = memo(MessagesInner, areMessagesPropsEqual)

export default Messages
