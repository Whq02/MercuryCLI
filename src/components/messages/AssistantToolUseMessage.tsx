import React, { useSyncExternalStore } from 'react'
import { Box, Text } from '../../ink.js'
import { stringWidth } from '../../ink/stringWidth.js'
import type { ProgressMessage } from '../../types/message.js'
import type { ToolUseBlockParam } from '../../types/wire.js'
import type { Tools } from '../../Tool.js'
import { filterToolProgressMessages, safeUserFacingName } from '../../Tool.js'
import { findToolForRender } from '../../tools/MCPTool/absentToolShim.js'
import { BASH_TOOL_NAME } from '../../constants/tools/bash.js'
import { useAppStateMaybeOutsideOfProvider } from '../../state/AppState.js'
import { logError } from '../../utils/log.js'
import type { MessageLookups } from '../../services/messages/lookups.js'
import { summarizeToolResult } from '../../tools/toolResultSummary.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import { getSettingsSnapshot, settingsRevision } from '../../utils/settings/snapshot.js'
import { useFluxMountMark } from '../../hooks/useFluxMountMark.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useTerminalFocus } from '../../ink/hooks/use-terminal-focus.js'
import { useActionAffordance } from '../../keybindings/useShortcutDisplay.js'
import {
  BACKGROUND_HINT_ACTION,
  BACKGROUND_HINT_AFTER_MS,
  BACKGROUND_HINT_WORDS,
  useFocusedShellToolRunning,
} from '../../services/engine-connector/shellRunning.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { useNowTick } from '../mercury-ui/components.js'
import { toolFamilyFor } from '../mercury-ui/toolGlyphs.js'
import { MessageResponse } from '../MessageResponse.js'
import { HookProgressMessage } from './HookProgressMessage.js'
import { ToolRowLead, toolRowStateOf } from './ToolRowLead.js'
import { TranscriptNameplate } from './TranscriptNameplate.js'
import { useSelectedMessageBg } from '../messageActions.js'
import { isRecord } from '../../utils/isRecord.js'

const EDIT_META_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])
const NAME_MIN_COLUMNS = 12
const ELAPSED_VISIBLE_MS = 10_000
const ELAPSED_TICK_MS = 960
const START_STAMP_BOUND = 256
const INLINE_SUMMARY_MAX_CELLS = 32


const toolStartStamps = new Map<string, number>()

function seedStamp(id: string, at: number): void {
  if (!toolStartStamps.has(id) && toolStartStamps.size >= START_STAMP_BOUND) {
    const oldest = toolStartStamps.keys().next().value
    if (oldest !== undefined) toolStartStamps.delete(oldest)
  }
  toolStartStamps.set(id, at)
}

export function _seedToolStartStamp(id: string, at: number): void {
  seedStamp(id, at)
}

export function RunningToolElapsed({
  id,
  running,
  startedAtMs = null,
}: {
  id: string
  running: boolean
  startedAtMs?: number | null
}): React.ReactNode {
  const reducedMotion =
    useAppStateMaybeOutsideOfProvider(
      state => state.settings.view?.reducedMotion,
    ) ?? false
  const focused = useTerminalFocus()
  const ticking = running && focused && !reducedMotion
  useNowTick(ticking ? ELAPSED_TICK_MS : null)

  if (!running) {
    toolStartStamps.delete(id)
    return null
  }
  const recorded = startedAtMs !== null && Number.isFinite(startedAtMs) ? startedAtMs : null
  if (recorded !== null) {
    if (toolStartStamps.get(id) !== recorded) seedStamp(id, recorded)
  } else if (!toolStartStamps.has(id)) seedStamp(id, Date.now())
  const startedAt = toolStartStamps.get(id) ?? Date.now()
  const elapsedMs = Math.max(0, Date.now() - startedAt)
  if (elapsedMs < ELAPSED_VISIBLE_MS) return null
  return <Text dimColor> · {Math.floor(elapsedMs / 1000)}s</Text>
}

export function RunningShellBackgroundHint({ id }: { id: string }): React.ReactNode {
  const reducedMotion =
    useAppStateMaybeOutsideOfProvider(
      state => state.settings.view?.reducedMotion,
    ) ?? false
  const focused = useTerminalFocus()
  const shellHere = useFocusedShellToolRunning(id)
  useSyncExternalStore(settingsChangeDetector.subscribe, settingsRevision, settingsRevision)
  const affordance = useActionAffordance(BACKGROUND_HINT_ACTION, 'Chat')
  const chord = affordance.kind === 'bound' ? affordance.chord : null
  const offered = shellHere && chord !== null && getSettingsSnapshot().settings.view?.backgroundKey !== false
  useNowTick(offered && focused && !reducedMotion ? ELAPSED_TICK_MS : null)
  if (!offered || chord === null) return null
  if (!toolStartStamps.has(id)) seedStamp(id, Date.now())
  const startedAt = toolStartStamps.get(id) ?? Date.now()
  if (Date.now() - startedAt < BACKGROUND_HINT_AFTER_MS) return null
  return (
    <Box paddingLeft={4}>
      <Text dimColor>
        <KeyboardShortcutHint shortcut={chord} action={BACKGROUND_HINT_WORDS} />
      </Text>
    </Box>
  )
}


function editMetaCounts(
  rawResult: unknown,
): { added: number; removed: number } | null {
  if (!isRecord(rawResult) || !Array.isArray(rawResult.structuredPatch)) return null
  let added = 0
  let removed = 0
  for (const hunk of rawResult.structuredPatch) {
    if (!isRecord(hunk) || !Array.isArray(hunk.lines)) continue
    for (const line of hunk.lines) {
      if (typeof line !== 'string') continue
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) removed += 1
    }
  }
  if (added === 0 && removed === 0) return null
  return { added, removed }
}


const HEAD_RESERVATION_CELLS = 38

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
  startedAtMs = null,
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
  startedAtMs?: number | null
}): React.ReactNode {
  useFluxMountMark(`tool-row:${param.id}`)
  const { columns, rows } = useTerminalSize()
  const selectedBg = useSelectedMessageBg()

  if (tools.length === 0) {
    logError(new Error('AssistantToolUseMessage rendered with no tools'))
    return null
  }

  const tool = findToolForRender(tools, param.name)
  const resolved = lookups.resolvedToolUseIDs.has(param.id)
  const errored = lookups.erroredToolUseIDs.has(param.id)
  const denied = lookups.deniedToolUseIDs.has(param.id)
  const isInProgress = inProgressToolUseIDs.has(param.id)
  const isQueued = !resolved && !isInProgress
  const isRunning = isInProgress && !resolved
  if (!isRunning) {
    toolStartStamps.delete(param.id)
  }

  const displayName = safeUserFacingName(tool, param.input)
  if (displayName === '') {
    return null
  }

  const renderProgressBlock = (): React.ReactNode => {
    const hookNode = (
      <HookProgressMessage
        hookEvent="tool.before"
        toolUseID={param.id}
        lookups={lookups}
        progress={progressMessagesForMessage}
        isTranscriptMode={isTranscriptMode}
      />
    )
    let toolProgress: React.ReactNode = null
    if (tool.renderToolUseProgressMessage) {
      try {
        const filtered = filterToolProgressMessages(progressMessagesForMessage)
        toolProgress = tool.renderToolUseProgressMessage(filtered, {
          tools,
          verbose,
          terminalSize: { columns, rows },
          inProgressToolCallCount,
          isTranscriptMode,
          toolUseID: param.id,
        })
      } catch (error) {
        logError(error)
        toolProgress = null
      }
    }
    const wrappedProgress =
      toolProgress === null || toolProgress === undefined || toolProgress === false
        ? null
        : React.isValidElement(toolProgress)
          ? toolProgress
          : <Text>{toolProgress}</Text>
    return (
      <>
        {hookNode}
        {wrappedProgress}
      </>
    )
  }

  if (tool.isTransparentWrapper?.()) {
    if (!isRunning) return null
    return (
      <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
        {renderProgressBlock()}
      </Box>
    )
  }

  let parsedInput: unknown = param.input
  if (tool.inputSchema?.safeParse) {
    const parsed = tool.inputSchema.safeParse(param.input)
    if (!parsed.success) {
      return null
    }
    parsedInput = parsed.data
  }

  if (typeof tool.renderToolUseMessage !== 'function') {
    return null
  }
  let toolUseMessage: React.ReactNode | string | null = null
  try {
    toolUseMessage = tool.renderToolUseMessage(parsedInput, {
      verbose,
      theme: undefined,
    })
  } catch (error) {
    logError(error)
    toolUseMessage = ''
  }
  if (toolUseMessage === null || toolUseMessage === undefined) {
    return null
  }

  let toolUseTag: React.ReactNode | string | null = null
  if (tool.renderToolUseTag) {
    try {
      toolUseTag = tool.renderToolUseTag(parsedInput, { verbose })
    } catch (error) {
      logError(error)
      toolUseTag = null
    }
  }

  let nameBgColor: string | undefined
  if (tool.userFacingNameBackgroundColor) {
    try {
      nameBgColor = tool.userFacingNameBackgroundColor(parsedInput)
    } catch (error) {
      logError(error)
      nameBgColor = undefined
    }
  }

  const rowState = toolRowStateOf({ resolved, errored, denied })
  const resultRow = lookups.toolResultByToolUseID.get(param.id)
  const rawResult =
    resultRow && resultRow.type === 'user' ? resultRow.toolUseResult : undefined
  const showCompactMeta =
    resolved && !errored && !verbose && !isTranscriptMode && rawResult !== undefined

  const editCounts =
    showCompactMeta && EDIT_META_TOOLS.has(tool.name)
      ? editMetaCounts(rawResult)
      : null
  const editMetaText =
    editCounts !== null ? ` · +${editCounts.added}/-${editCounts.removed}` : null
  const showEditMeta =
    editMetaText !== null &&
    HEAD_RESERVATION_CELLS + stringWidth(editMetaText) <= columns

  const resultSummary = showCompactMeta
    ? summarizeToolResult(tool.name, rawResult)
    : null
  const summaryWidth = resultSummary !== null ? stringWidth(resultSummary) : 0
  const showInlineSummary =
    resultSummary !== null &&
    summaryWidth <= INLINE_SUMMARY_MAX_CELLS &&
    HEAD_RESERVATION_CELLS + 1 + summaryWidth <= columns
  const showBlockSummary = resultSummary !== null && !showInlineSummary

  let queuedNode: React.ReactNode = null
  if (isQueued && tool.renderToolUseQueuedMessage) {
    try {
      queuedNode = tool.renderToolUseQueuedMessage(parsedInput, { verbose })
    } catch (error) {
      logError(error)
      queuedNode = null
    }
  }

  const nameWidth = stringWidth(displayName)
  const paddedName =
    nameBgColor === undefined && nameWidth < NAME_MIN_COLUMNS
      ? `${displayName}${' '.repeat(NAME_MIN_COLUMNS - nameWidth)}`
      : displayName

  const hasTarget =
    toolUseMessage !== '' &&
    toolUseMessage !== false
  const hasTag =
    toolUseTag !== null &&
    toolUseTag !== undefined &&
    toolUseTag !== '' &&
    toolUseTag !== false

  return (
    <Box
      flexDirection="column"
      marginTop={addMargin ? 1 : 0}
      backgroundColor={selectedBg}
    >
      <Box>
        {shouldShowDot ? (
          <Box flexShrink={0}>
            <TranscriptNameplate />
          </Box>
        ) : null}
        <Text wrap="truncate-middle">
          <ToolRowLead family={toolFamilyFor(tool.name)} state={rowState} />
          {nameBgColor !== undefined ? (
            <Text bold backgroundColor={nameBgColor} color="inverseText">
              {displayName}
            </Text>
          ) : (
            <Text bold>{paddedName}</Text>
          )}
          {hasTarget ? <Text color="subtle"> {toolUseMessage}</Text> : null}
          {isRunning && shouldAnimate ? (
            <RunningToolElapsed
              id={param.id}
              running={true}
              startedAtMs={startedAtMs}
            />
          ) : null}
          {showEditMeta && editCounts !== null ? (
            <Text>
              <Text dimColor> · </Text>
              <Text color="success">+{editCounts.added}</Text>
              <Text dimColor>/</Text>
              <Text color="error">-{editCounts.removed}</Text>
            </Text>
          ) : null}
          {showInlineSummary && resultSummary !== null ? (
            <Text dimColor> {resultSummary}</Text>
          ) : null}
          {hasTag ? <Text> {toolUseTag}</Text> : null}
        </Text>
      </Box>
      {showBlockSummary && resultSummary !== null ? (
        <MessageResponse height={1}>
          <Text dimColor wrap="truncate">
            {resultSummary}
          </Text>
        </MessageResponse>
      ) : null}
      {isRunning ? renderProgressBlock() : null}
      {isRunning &&
      shouldAnimate &&
      !isTranscriptMode &&
      tool.name === BASH_TOOL_NAME ? (
        <RunningShellBackgroundHint id={param.id} />
      ) : null}
      {queuedNode !== null && queuedNode !== undefined && queuedNode !== false ? (
        <MessageResponse height={1}>{queuedNode}</MessageResponse>
      ) : null}
    </Box>
  )
}

export default AssistantToolUseMessage
