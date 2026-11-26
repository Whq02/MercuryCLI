import React, { useSyncExternalStore } from 'react'
import { Box, Text } from '../themedRenderer.js'
import { stringWidth } from '../renderer/stringWidth.js'
import type { ProgressMessage } from '../../engine/message-shapes/message.js'
import type { ToolUseBlockParam } from '../../engine/message-shapes/wire.js'
import type { Tools } from '../../tools/kit/tool.js'
import { filterToolProgressMessages, safeUserFacingName } from '../../tools/kit/tool.js'
import { findToolForRender } from '../../tools/mcp/absentToolShim.js'
import { BASH_TOOL_NAME } from '../../tools/kit/names/bash.js'
import { useAppStateMaybeOutsideOfProvider } from '../app-state/AppState.js'
import { logError } from '../../platform/logs/errorLog.js'
import type { MessageLookups } from '../../engine/messages/lookups.js'
import { isSchemaValidationRefusal } from '../../tools/kit/toolErrors.js'
import { summarizeToolResult } from '../../tools/kit/toolResultSummary.js'
import { settingsChangeDetector } from '../../platform/settings/changeDetector.js'
import { getSettingsSnapshot, settingsRevision } from '../../platform/settings/snapshot.js'
import { useFluxMountMark } from './useFluxMountMark.js'
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js'
import { useTerminalFocus } from '../renderer/bindings/use-terminal-focus.js'
import { useActionAffordance } from '../keys/useShortcutDisplay.js'
import {
  BACKGROUND_HINT_ACTION,
  BACKGROUND_HINT_AFTER_MS,
  BACKGROUND_HINT_WORDS,
  useFocusedShellToolRunning,
} from '../../engine/connector/shellRunning.js'
import { KeyboardShortcutHint } from '../theme/KeyboardShortcutHint.js'
import { useNowTick } from '../widgets/components.js'
import { MessageResponse } from '../../tools/kit/MessageResponse.js'
import { HookProgressMessage } from './HookProgressMessage.js'
import { ToolRowLead, toolRowStateOf } from './ToolRowLead.js'
import { TranscriptNameplate } from './TranscriptNameplate.js'
import { useSelectedMessageBg } from './messageActions.js'

const EDIT_META_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])
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

function toolResultContentOf(
  resultRow: ReturnType<MessageLookups['toolResultByToolUseID']['get']>,
  toolUseId: string,
): unknown {
  if (!resultRow || resultRow.type !== 'user') return undefined
  if (resultRow.toolUseResult !== undefined) return resultRow.toolUseResult
  const content = resultRow.message.content
  if (!Array.isArray(content)) return undefined
  const block = content.find(
    item => item.type === 'tool_result' && item.tool_use_id === toolUseId,
  )
  return block && block.type === 'tool_result' ? block.content : undefined
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

  const displayName = safeUserFacingName(tool, param.input, param.name)
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

  const resultRow = lookups.toolResultByToolUseID.get(param.id)
  const rawResult =
    resultRow && resultRow.type === 'user' ? resultRow.toolUseResult : undefined
  const showInvalidInput =
    resolved &&
    errored &&
    !verbose &&
    !isTranscriptMode &&
    isSchemaValidationRefusal(tool.name, toolResultContentOf(resultRow, param.id))

  let parsedInput: unknown = param.input
  let inputValid = true
  if (tool.inputSchema?.safeParse) {
    const parsed = tool.inputSchema.safeParse(param.input)
    if (!parsed.success) {
      if (!showInvalidInput) {
        return null
      }
      inputValid = false
    } else {
      parsedInput = parsed.data
    }
  }

  let toolUseMessage: React.ReactNode | string | null = ''
  if (inputValid) {
    if (typeof tool.renderToolUseMessage !== 'function') {
      if (!showInvalidInput) return null
    } else {
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
        if (!showInvalidInput) return null
        toolUseMessage = ''
      }
    }
  }

  let toolUseTag: React.ReactNode | string | null = null
  if (inputValid && tool.renderToolUseTag) {
    try {
      toolUseTag = tool.renderToolUseTag(parsedInput, { verbose })
    } catch (error) {
      logError(error)
      toolUseTag = null
    }
  }

  let nameBgColor: string | undefined
  if (inputValid && tool.userFacingNameBackgroundColor) {
    try {
      nameBgColor = tool.userFacingNameBackgroundColor(parsedInput)
    } catch (error) {
      logError(error)
      nameBgColor = undefined
    }
  }

  const rowState = toolRowStateOf({ resolved, errored, denied })
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

  const resultSummary = showInvalidInput
    ? '· invalid input'
    : showCompactMeta
      ? summarizeToolResult(tool.name, rawResult, parsedInput)
      : null
  const summaryWidth = resultSummary !== null ? stringWidth(resultSummary) : 0
  const showInlineSummary =
    resultSummary !== null &&
    summaryWidth <= INLINE_SUMMARY_MAX_CELLS &&
    HEAD_RESERVATION_CELLS + 1 + summaryWidth <= columns
  const showBlockSummary = resultSummary !== null && !showInlineSummary

  let queuedNode: React.ReactNode = null
  if (inputValid && isQueued && tool.renderToolUseQueuedMessage) {
    try {
      queuedNode = tool.renderToolUseQueuedMessage(parsedInput, { verbose })
    } catch (error) {
      logError(error)
      queuedNode = null
    }
  }

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
        <Box flexShrink={0}>
          <ToolRowLead state={rowState} />
        </Box>
        {shouldShowDot ? (
          <Box flexShrink={0}>
            <TranscriptNameplate />
          </Box>
        ) : null}
        <Text wrap="truncate-middle">
          {nameBgColor !== undefined ? (
            <Text bold backgroundColor={nameBgColor} color="inverseText">
              {displayName}
            </Text>
          ) : (
            <Text bold>{displayName}</Text>
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
        <Box paddingLeft={2}>
          <MessageResponse height={1}>
            <Text dimColor wrap="truncate">
              {resultSummary}
            </Text>
          </MessageResponse>
        </Box>
      ) : null}
      {isRunning ? (
        <Box flexDirection="column" paddingLeft={2}>
          {renderProgressBlock()}
        </Box>
      ) : null}
      {isRunning &&
      shouldAnimate &&
      !isTranscriptMode &&
      tool.name === BASH_TOOL_NAME ? (
        <Box paddingLeft={2}>
          <RunningShellBackgroundHint id={param.id} />
        </Box>
      ) : null}
      {queuedNode !== null && queuedNode !== undefined && queuedNode !== false ? (
        <Box paddingLeft={2}>
          <MessageResponse height={1}>{queuedNode}</MessageResponse>
        </Box>
      ) : null}
    </Box>
  )
}

export default AssistantToolUseMessage
