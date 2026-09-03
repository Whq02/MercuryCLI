// The tool-call header card: state dot, family mark, name, target, elapsed
// tail, edit meta tail, inline short result and the progress body. State
// comes only from the message lookups; counts and durations are real
// recorded data or absent — never invented.

import React from 'react'
import { Box, Text } from '../../ink.js'
import { stringWidth } from '../../ink/stringWidth.js'
import type { ProgressMessage } from '../../types/message.js'
import type { ToolUseBlockParam } from '../../types/wire.js'
import type { Tools } from '../../Tool.js'
import { filterToolProgressMessages, safeUserFacingName } from '../../Tool.js'
import { findToolForRender } from '../../tools/MCPTool/absentToolShim.js'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import { useAppStateMaybeOutsideOfProvider } from '../../state/AppState.js'
import { logError } from '../../utils/log.js'
import type { MessageLookups } from '../../utils/messages/lookups.js'
import { summarizeToolResult } from '../../utils/toolResultSummary.js'
import { useFluxMountMark } from '../../hooks/useFluxMountMark.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useTerminalFocus } from '../../ink/hooks/use-terminal-focus.js'
import { useNowTick } from '../mercury-ui/components.js'
import { toolMarkFor, toolToneFor } from '../mercury-ui/toolGlyphs.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { ToolUseLoader } from '../ToolUseLoader.js'
import { MessageResponse } from '../MessageResponse.js'
import { HookProgressMessage } from './HookProgressMessage.js'
import { TranscriptNameplate } from './TranscriptNameplate.js'
import { useSelectedMessageBg } from '../messageActions.js'

/** Edit-tailed tools (contract data). */
const EDIT_META_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])
const NAME_MIN_COLUMNS = 12
const ELAPSED_VISIBLE_MS = 10_000
const ELAPSED_TICK_MS = 960
const START_STAMP_BOUND = 256
const INLINE_SUMMARY_MAX_CELLS = 32

// ── the elapsed tail ────────────────────────────────────────────────────────

// Start stamps live process-wide under the tool-use id: a row the virtual
// list unmounts while its tool still runs never reaches the render that
// would remove its entry, so the map is bounded (oldest evicted past the
// bound).
const toolStartStamps = new Map<string, number>()

function seedStamp(id: string, at: number): void {
  if (!toolStartStamps.has(id) && toolStartStamps.size >= START_STAMP_BOUND) {
    const oldest = toolStartStamps.keys().next().value
    if (oldest !== undefined) toolStartStamps.delete(oldest)
  }
  toolStartStamps.set(id, at)
}

/** Test-only: lets a prover render the elapsed tail without holding a tool
 *  open for ten real seconds. Must remain exported. */
export function _seedToolStartStamp(id: string, at: number): void {
  seedStamp(id, at)
}

export function RunningToolElapsed({
  id,
  running,
}: {
  id: string
  running: boolean
}): React.ReactNode {
  // Reduced motion through the tolerant outside-a-provider accessor —
  // defaults off so a bare prover mount still works.
  const reducedMotion =
    useAppStateMaybeOutsideOfProvider(
      state => state.settings.prefersReducedMotion,
    ) ?? false
  const focused = useTerminalFocus()
  const ticking = running && focused && !reducedMotion
  // The 960 ms tick nests on the existing motion lattice; the timer stops
  // (holding the last painted value) when unfocused or reduced motion.
  useNowTick(ticking ? ELAPSED_TICK_MS : null)

  if (!running) {
    // Removed on the first render in which it is not running, so the same
    // id restarts cleanly if it ever runs again.
    toolStartStamps.delete(id)
    return null
  }
  if (!toolStartStamps.has(id)) seedStamp(id, Date.now())
  const startedAt = toolStartStamps.get(id) ?? Date.now()
  const elapsedMs = Date.now() - startedAt
  if (elapsedMs < ELAPSED_VISIBLE_MS) return null
  // The muted tail wears the estate's ` · ` metadata separator; a bare
  // ` 15s` reads as part of the target text.
  return <Text dimColor> · {Math.floor(elapsedMs / 1000)}s</Text>
}

// ── the edit meta tail ──────────────────────────────────────────────────────

function editMetaCounts(
  rawResult: unknown,
): { added: number; removed: number } | null {
  const patch = (rawResult as { structuredPatch?: Array<{ lines?: string[] }> })
    ?.structuredPatch
  if (!Array.isArray(patch)) return null
  let added = 0
  let removed = 0
  for (const hunk of patch) {
    for (const line of hunk.lines ?? []) {
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) removed += 1
    }
  }
  if (added === 0 && removed === 0) return null
  return { added, removed }
}

// ── the component ───────────────────────────────────────────────────────────

export function AssistantToolUseMessage({
  param,
  addMargin = false,
  tools,
  verbose = false,
  inProgressToolUseIDs,
  progressMessagesForMessage = [],
  shouldAnimate = false,
  shouldShowDot = false,
  inProgressToolCallCount = 1,
  lookups,
  isTranscriptMode = false,
}: {
  param: ToolUseBlockParam
  addMargin?: boolean
  tools: Tools
  commands?: unknown
  verbose?: boolean
  inProgressToolUseIDs: Set<string>
  progressMessagesForMessage?: ProgressMessage[]
  shouldAnimate?: boolean
  shouldShowDot?: boolean
  inProgressToolCallCount?: number
  lookups: MessageLookups
  isTranscriptMode?: boolean
}): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const tokens = useMercuryTokens()
  // The selected-message background belongs on the box that owns the top
  // margin, so the margin row is not painted.
  const selectedBg = useSelectedMessageBg()
  // Probe-armed mount-mark instrumentation, keyed by tool-use id under the
  // semantic `tool-row:` kind (the out-of-process provers' vocabulary);
  // inert unless the probe flag is set.
  useFluxMountMark(`tool-row:${param.id}`)

  if (!tools || tools.length === 0) {
    logError(new Error('AssistantToolUseMessage rendered with no tools'))
    return null
  }
  // A tool that left the live registry (a disconnected MCP server, a config
  // edit, a resume without it) must not erase its history rows: the absence
  // shim keeps the recorded row painting (sweep #2, packet 66).
  const tool = findToolForRender(tools, param.name)

  // State comes only from the lookups.
  const resolved = lookups.resolvedToolUseIDs.has(param.id)
  const inProgress = inProgressToolUseIDs.has(param.id)
  const queued = !resolved && !inProgress
  const errored = lookups.erroredToolUseIDs.has(param.id)
  const denied = lookups.deniedToolUseIDs.has(param.id)
  const running = inProgress && !resolved

  const userFacingName = safeUserFacingName(tool, param.input, param.name)
  // An empty user-facing name opts out of tool chrome entirely.
  if (userFacingName === '') return null

  // A transparent wrapper renders only its progress body, only while
  // actually running.
  if (tool.isTransparentWrapper?.()) {
    if (!running) return null
    return renderProgressBody()
  }

  // The use-message renders only for a parsed input; a schema failure
  // suppresses the row, a THROWING renderer degrades to an empty target.
  const parsedInput = tool.inputSchema?.safeParse
    ? tool.inputSchema.safeParse(param.input)
    : { success: true as const, data: param.input }
  if (!parsedInput.success) return null
  let useMessage: React.ReactNode | string | null = null
  try {
    useMessage =
      tool.renderToolUseMessage?.(parsedInput.data, {
        verbose,
        theme: undefined,
      }) ?? null
  } catch (error) {
    logError(error)
    useMessage = ''
  }
  if (useMessage === null) return null

  const mark = toolMarkFor(param.name)
  const tone = toolToneFor(param.name, tokens)
  const isReadTool = param.name === FILE_READ_TOOL_NAME

  // The inline short result: same summariser, same key (the tool-use
  // block's name) as the downstream result row that suppresses itself.
  const rawResult = resolved
    ? (
        lookups.toolResultByToolUseID.get(param.id) as
          | { toolUseResult?: unknown }
          | undefined
      )?.toolUseResult
    : undefined
  const summary =
    resolved && !errored && !verbose && !isTranscriptMode && rawResult !== undefined
      ? summarizeToolResult(param.name, rawResult)
      : null
  // THE TAIL GATE: the old raw eighty-column gate was a
  // proxy for "will the tail displace the target text" that read the raw
  // width, not the width the row actually has. The row's head needs
  // dot(2) + mark(2) + the name floor + ~20 readable target cells +
  // gutter(4); a tail is admitted exactly when the row affords head + THAT
  // tail — a short tail fits a 76-column row, a long one is refused at 90.
  const ROW_HEAD_FLOOR = 2 + 2 + NAME_MIN_COLUMNS + 20 + 4
  const tailFits = (tailCells: number): boolean => columns >= ROW_HEAD_FLOOR + tailCells
  const summaryInline =
    summary !== null &&
    stringWidth(summary) <= INLINE_SUMMARY_MAX_CELLS &&
    tailFits(1 + stringWidth(summary))

  // The edit meta tail from the persisted structured patch — deliberately
  // NOT the summariser (the edit result row is the diff card and must keep
  // rendering).
  const editMetaRaw =
    EDIT_META_TOOLS.has(param.name) &&
    resolved &&
    !errored &&
    !verbose &&
    !isTranscriptMode &&
    rawResult !== undefined
      ? editMetaCounts(rawResult)
      : null
  const editMeta =
    editMetaRaw !== null && tailFits(stringWidth(` · +${editMetaRaw.added}/-${editMetaRaw.removed}`))
      ? editMetaRaw
      : null

  let tag: React.ReactNode | string | null = null
  try {
    tag = tool.renderToolUseTag?.(parsedInput.data, { verbose }) ?? null
  } catch (error) {
    logError(error)
    tag = null
  }

  const nameBackground = tool.userFacingNameBackgroundColor?.(
    parsedInput.data,
  )

  function renderProgressBody(): React.ReactNode {
    const toolProgress = filterToolProgressMessages(
      progressMessagesForMessage,
    ) as ProgressMessage[]
    let body: React.ReactNode = null
    try {
      body =
        tool!.renderToolUseProgressMessage?.(toolProgress, {
          tools,
          verbose,
          columns,
          rows,
          inProgressToolCallCount,
          // The row's own tool-use id: a launcher's card joins its rows to
          // the session's work roster by it (the Agent tool's crew record).
          toolUseID: param.id,
        }) ?? null
    } catch (error) {
      logError(error)
      body = null
    }
    // TOTAL over ReactNode (C14 — the class A2/Byline closed): the tool's
    // progress render lands inside a Box; a future tool returning bare
    // text would trip Ink's text invariant at the app root. The passthrough
    // owns the totality, not each tool.
    const totalBody = React.Children.toArray(body).map((child, position) =>
      React.isValidElement(child) ? (
        child
      ) : (
        <Text key={`total-${position}`}>{child}</Text>
      ),
    )
    return (
      <Box flexDirection="column">
        <HookProgressMessage
          hookEvent="PreToolUse"
          toolUseID={param.id}
          lookups={lookups}
          isTranscriptMode={isTranscriptMode}
        />
        {totalBody}
      </Box>
    )
  }

  let queuedMessage: React.ReactNode = null
  if (queued) {
    try {
      queuedMessage =
        tool.renderToolUseQueuedMessage?.(parsedInput.data, {
          verbose,
        }) ?? null
    } catch (error) {
      logError(error)
      queuedMessage = null
    }
  }

  const targetText = typeof useMessage === 'string' ? useMessage : null

  return (
    <Box
      flexDirection="column"
      marginTop={addMargin ? 1 : 0}
      backgroundColor={selectedBg}
    >
      <Box>
        {/* The nameplate is a row child beside a target run that overflows the
            row; a bare Text shrinks (flexShrink defaults to 1) and wraps the
            name onto a second line, so a non-shrinking box pins its width. */}
        {shouldShowDot ? (
          <Box flexShrink={0}>
            <TranscriptNameplate />
          </Box>
        ) : null}
        {/* The loader is a Box-returning leaf (animation viewport ref) — it
            must ride the row as a SIBLING of the text run, never inside it. */}
        {shouldShowDot && !queued ? (
          <ToolUseLoader
            isError={errored}
            isUnresolved={!resolved}
            shouldAnimate={shouldAnimate && running}
            isRead={isReadTool && resolved && !errored}
            isDenied={denied}
          />
        ) : null}
        {/* One line always; the cut is MIDDLE-anchored so the row's head
            (mark, tool name, a path's leading directories) AND its tail
            (the filename, edit meta) both survive a long target — an
            end-anchored cut loses exactly the filename. */}
        <Text wrap="truncate-middle">
          {shouldShowDot && !queued ? ' ' : null}
          {shouldShowDot && queued ? <Text dimColor>● </Text> : null}
          <Text color={tone}>{mark.glyph} </Text>
          {nameBackground ? (
            <Text inverse backgroundColor={nameBackground} bold>
              {userFacingName}
            </Text>
          ) : (
            <Text bold>
              {userFacingName.length < NAME_MIN_COLUMNS
                ? userFacingName.padEnd(NAME_MIN_COLUMNS)
                : userFacingName}
            </Text>
          )}
          {useMessage !== '' ? (
            <Text color="subtle" wrap="truncate-middle">
              {' '}
              {targetText ?? useMessage}
            </Text>
          ) : null}
          <RunningToolElapsed id={param.id} running={running && shouldAnimate} />
          {editMeta ? (
            // The settled ± tail wears the row's own `·` separator grammar
            // (`● Edit Deck.tsx · +12/-3`), the counts toned by direction.
            <Text>
              {' '}
              <Text color="subtle">· </Text>
              <Text color="success">+{editMeta.added}</Text>
              <Text color="error">/-{editMeta.removed}</Text>
            </Text>
          ) : null}
          {summaryInline ? <Text dimColor> {summary}</Text> : null}
          {tag !== null && tag !== '' ? <Text> {tag}</Text> : null}
        </Text>
      </Box>
      {summary !== null && !summaryInline ? (
        <MessageResponse height={1}>
          <Text dimColor wrap="truncate-end">
            {summary}
          </Text>
        </MessageResponse>
      ) : null}
      {running ? renderProgressBody() : null}
      {queuedMessage !== null ? (
        <MessageResponse>{queuedMessage}</MessageResponse>
      ) : null}
    </Box>
  )
}

export default AssistantToolUseMessage
