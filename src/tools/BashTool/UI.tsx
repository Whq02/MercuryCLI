import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { oneLineCommandDisplay, TOOL_USE_LINE_MAX_CHARS } from '../commandDisplay.js'
import { FAINT } from '../../components/mercuryPalette.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { ShellProgressMessage } from '../../components/shell/ShellProgressMessage.js'
import BashToolResultMessage from './BashToolResultMessage.js'
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import { useAppStateStore } from '../../state/AppState.js'
import { backgroundAll } from '../../tasks/LocalShellTask/LocalShellTask.js'
import { isInsideTmuxSync } from '../../utils/swarm/backends/detection.js'
import { isSedInPlaceEdit, parseSedEditCommand } from './sedEditParser.js'
import { extractBashCommentLabel } from './commentLabel.js'
import { getDisplayPath } from '../../utils/file.js'
import { isFullscreenActive } from '../../utils/fullscreen.js'
import type { ProgressMessage } from '../../types/message.js'
import type { BashProgress } from '../../types/tools.js'
import type { ToolResultBlockParam } from '../../types/wire.js'

/** The tool-use / progress / queued / result / error input shapes this module renders. */
type BashInput = {
  command?: string
  timeout?: number
  description?: string
}

// C6 (TS-1): the header is ONE row — the shared fold owns the law
// (src/tools/commandDisplay.ts); the old two-line truncation retired.

/** The tool-use line for a (possibly partial) Bash input. */
export function renderToolUseMessage(
  input: Partial<BashInput>,
  { verbose }: { theme?: unknown; verbose: boolean; commands?: unknown },
): React.ReactNode {
  const command = input.command
  if (!command) return null

  // A simulated in-place sed edit renders as its file path.
  if (isSedInPlaceEdit(command)) {
    const info = parseSedEditCommand(command)
    if (info) {
      return <Text>{verbose ? info.filePath : getDisplayPath(info.filePath)}</Text>
    }
  }

  if (verbose) return <Text>{command}</Text>

  // Under fullscreen mode a leading `#` comment (not a shebang) becomes the label.
  if (isFullscreenActive()) {
    const label = extractBashCommentLabel(command)
    if (label) {
      const shown = label.length > TOOL_USE_LINE_MAX_CHARS ? `${label.slice(0, TOOL_USE_LINE_MAX_CHARS)}…` : label
      return <Text>{shown}</Text>
    }
  }

  return <Text>{oneLineCommandDisplay(command)}</Text>
}

/** The progress line: a dimmed "running" line, or the shared shell-progress component. */
export function renderToolUseProgressMessage(
  progressMessages: ProgressMessage<BashProgress>[],
  { verbose }: {
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

/** The queued line: a single dimmed "waiting" line. */
export function renderToolUseQueuedMessage(): React.ReactNode {
  return (
    <Text color={FAINT} dimColor>
      waiting…
    </Text>
  )
}

/** The result renderer: reads the timeout from the most recent progress message. */
export function renderToolResultMessage(
  content: unknown,
  progressMessages: ProgressMessage<BashProgress>[],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  const timeoutMs = progressMessages[progressMessages.length - 1]?.data?.timeoutMs
  return (
    <BashToolResultMessage
      content={content as never}
      verbose={verbose}
      timeoutMs={timeoutMs}
    />
  )
}

/** The error line: delegate to the shared fallback tool-error renderer. */
export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { progressMessagesForMessage?: unknown; tools?: unknown; verbose: boolean },
): React.ReactNode {
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}

/**
 * The "run this in the background" hint row. It always binds the task-background
 * chord and resolves its display string BEFORE checking the environment — the
 * binding and lookup are hooks and cannot sit behind an early return, so the
 * chord stays live even while the row is invisible.
 */
export function BackgroundHint({ onBackground }: { onBackground?: () => void } = {}): React.ReactNode {
  const store = useAppStateStore()
  useKeybinding(
    'task:background',
    () => {
      backgroundAll(store.getState, store.setState)
      onBackground?.()
    },
    { context: 'Task' },
  )
  const chord = useShortcutDisplay('task:background', 'Task', 'ctrl+b')

  // Under tmux the default chord must be pressed twice (it is the multiplexer
  // prefix) — but only while the resolved chord is still exactly the default.
  const tmuxDouble = chord === 'ctrl+b' && isInsideTmuxSync()

  return (
    <Box paddingLeft={5}>
      <Text color={FAINT} dimColor>
        (
        <KeyboardShortcutHint shortcut={chord} action="run in background" parens={false} />
        {tmuxDouble ? ' — press twice under tmux' : ''})
      </Text>
    </Box>
  )
}
