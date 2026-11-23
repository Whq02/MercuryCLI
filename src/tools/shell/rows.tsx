import * as React from 'react'
import { Box, Text } from '../../screen/themedRenderer.js'
import { oneLineCommandDisplay, TOOL_USE_LINE_MAX_CHARS } from '../kit/commandDisplay.js'
import { FAINT } from '../../screen/theme/mercuryPalette.js'
import { FallbackToolUseErrorMessage } from '../kit/FallbackToolUseErrorMessage.js'
import { MessageResponse } from '../kit/MessageResponse.js'
import { ShellProgressMessage } from '../../screen/shell-output/ShellProgressMessage.js'
import BashToolResultMessage, { type BashResultContent } from './BashToolResultMessage.js'
import { KeyboardShortcutHint } from '../../screen/theme/KeyboardShortcutHint.js'
import { useKeybinding } from '../../screen/keys/useKeybinding.js'
import { useShortcutDisplay } from '../../screen/keys/useShortcutDisplay.js'
import { useAppStateStore } from '../../screen/app-state/AppState.js'
import { backgroundAll } from '../../engine/tasks/local-shell/shellTask.js'
import { isInsideTmuxSync } from '../../platform/environment/terminalDetection.js'
import { isSedInPlaceEdit, parseSedEditCommand } from './sedEditParser.js'
import { extractBashCommentLabel } from './commentLabel.js'
import { getDisplayPath } from '../../platform/files/file.js'
import { isFullscreenActive } from '../../screen/fullscreen-layout/fullscreen.js'
import type { ProgressMessage } from '../../engine/message-shapes/message.js'
import type { BashProgress } from '../kit/toolProgress.js'
import type { ToolResultBlockParam } from '../../engine/message-shapes/wire.js'

type BashInput = {
  command?: string
  timeout?: number
  description?: string
}

export function renderToolUseMessage(
  input: Partial<BashInput>,
  { verbose }: { theme?: unknown; verbose: boolean; commands?: unknown },
): React.ReactNode {
  const command = input.command
  if (!command) return null
  if (isSedInPlaceEdit(command)) {
    const info = parseSedEditCommand(command)
    if (info !== null) {
      return verbose ? info.filePath : getDisplayPath(info.filePath)
    }
  }
  if (verbose) return command
  if (isFullscreenActive()) {
    const label = extractBashCommentLabel(command)
    if (label !== undefined) {
      return label.length > TOOL_USE_LINE_MAX_CHARS
        ? `${label.slice(0, TOOL_USE_LINE_MAX_CHARS).trimEnd()}…`
        : label
    }
  }
  return oneLineCommandDisplay(command)
}

export function renderToolUseProgressMessage(
  progressMessages: ProgressMessage<BashProgress>[],
  {
    verbose,
  }: {
    tools?: unknown
    verbose: boolean
    terminalSize?: { columns: number; rows: number }
    inProgressToolCallCount?: number
    isTranscriptMode?: boolean
  },
): React.ReactNode {
  const latest = progressMessages[progressMessages.length - 1]?.data
  if (!latest) {
    return (
      <MessageResponse height={1}>
        <Text color={FAINT} dimColor>
          running…
        </Text>
      </MessageResponse>
    )
  }
  return (
    <ShellProgressMessage
      output={latest.output}
      fullOutput={latest.fullOutput}
      elapsedTimeSeconds={latest.elapsedTimeSeconds}
      totalLines={latest.totalLines}
      totalBytes={latest.totalBytes}
      timeoutMs={latest.timeoutMs}
      taskId={latest.taskId}
      verbose={verbose}
    />
  )
}

export function renderToolUseQueuedMessage(): React.ReactNode {
  return (
    <Text color={FAINT} dimColor>
      waiting…
    </Text>
  )
}

export function renderToolResultMessage(
  content: BashResultContent,
  progressMessages: ProgressMessage<BashProgress>[],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  const timeoutMs = progressMessages[progressMessages.length - 1]?.data?.timeoutMs
  return (
    <BashToolResultMessage
      content={content}
      verbose={verbose}
      timeoutMs={timeoutMs}
    />
  )
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { progressMessagesForMessage?: unknown; tools?: unknown; verbose: boolean },
): React.ReactNode {
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}

export function BackgroundHint({
  onBackground,
}: { onBackground?: () => void } = {}): React.ReactNode {
  const store = useAppStateStore()
  useKeybinding(
    'task:background',
    () => {
      backgroundAll(store.getState, store.setState)
      onBackground?.()
    },
    { context: 'Task' },
  )
  const shortcut = useShortcutDisplay('task:background', 'Task', 'ctrl+b')
  const tmuxNote =
    shortcut === 'ctrl+b' && isInsideTmuxSync() ? ' — press twice under tmux' : ''
  return (
    <Box paddingLeft={5}>
      <Text color={FAINT} dimColor>
        <KeyboardShortcutHint shortcut={shortcut} action="run in background" />
        {tmuxNote}
      </Text>
    </Box>
  )
}
