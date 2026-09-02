import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { oneLineCommandDisplay } from '../commandDisplay.js'
import { FAINT } from '../../components/mercuryPalette.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { ShellProgressMessage } from '../../components/shell/ShellProgressMessage.js'
import { ShellTimeDisplay } from '../../components/shell/ShellTimeDisplay.js'
import { OutputLine } from '../../components/shell/OutputLine.js'
import { ToolCardMarker } from '../../components/mercury-ui/toolCardMeta.js'
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js'
import { DOWN_ARROW } from '../../constants/figures.js'
import type { ProgressMessage } from '../../types/message.js'
import type { PowerShellProgress } from '../../types/tools.js'
import type { ToolResultBlockParam } from '../../types/wire.js'

/** Tool-use line (C6 — TS-1): ONE row always — the shared fold
 *  (src/tools/commandDisplay.ts) collapses newlines to the ↵ marker and
 *  caps the length; verbose keeps the whole command (its surfaces own
 *  their bounds). */
export function renderToolUseMessage(input: Partial<{ command?: string; description?: string }>, { verbose }: { verbose: boolean; theme?: unknown }): React.ReactNode {
  const command = input.command
  if (!command) return null
  if (verbose) return command
  return <Text>{oneLineCommandDisplay(command)}</Text>
}

/** Progress line: the shared shell-progress component, or a dim running line. */
export function renderToolUseProgressMessage(
  progressMessages: ProgressMessage<PowerShellProgress>[],
  { verbose }: { tools?: unknown; verbose: boolean; terminalSize?: { columns: number; rows: number }; inProgressToolCallCount?: number },
): React.ReactNode {
  const latest = progressMessages[progressMessages.length - 1]?.data
  if (!latest) return <Text color={FAINT} dimColor>running…</Text>
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

/** Queued line. */
export function renderToolUseQueuedMessage(): React.ReactNode {
  return <Text color={FAINT} dimColor>waiting…</Text>
}

type PSResult = {
  stdout: string
  stderr: string
  interrupted?: boolean
  isImage?: boolean
  backgroundTaskId?: string
  returnCodeInterpretation?: string
}

/** Result renderer. */
export function renderToolResultMessage(
  content: PSResult,
  progressMessages: ProgressMessage<PowerShellProgress>[],
  { verbose }: { verbose: boolean; theme?: unknown; tools?: unknown; style?: unknown },
): React.ReactNode {
  const timeoutMs = progressMessages[progressMessages.length - 1]?.data?.timeoutMs
  if (content.isImage) {
    return <Text color={FAINT} dimColor>[image data detected and sent to Mercury]</Text>
  }
  const stdout = content.stdout ?? ''
  const stderr = content.stderr ?? ''
  const stdoutEmpty = stdout.trim() === ''
  const stderrBlank = stderr.trim() === ''
  return (
    <Box flexDirection="column">
      {!stdoutEmpty && <OutputLine content={stdout} verbose={verbose} />}
      {!stderrBlank && <OutputLine content={stderr} verbose={verbose} isError />}
      {stdoutEmpty && stderrBlank && <EmptyRow content={content} />}
      {typeof timeoutMs === 'number' && timeoutMs > 0 && <ShellTimeDisplay timeoutMs={timeoutMs} />}
    </Box>
  )
}

function EmptyRow({ content }: { content: PSResult }): React.ReactNode {
  if (content.backgroundTaskId) {
    return (
      <MessageResponse height={1}>
        <Text color={FAINT} dimColor>
          Running in the background — <KeyboardShortcutHint shortcut={DOWN_ARROW} action="manage" parens />
        </Text>
      </MessageResponse>
    )
  }
  if (content.interrupted) {
    return (
      <MessageResponse height={1}>
        <Text color={FAINT} dimColor>
          Interrupted
        </Text>
      </MessageResponse>
    )
  }
  return (
    <MessageResponse height={1}>
      <Text>
        <ToolCardMarker />
        <Text color={FAINT} dimColor>
          {content.returnCodeInterpretation ?? '(No output)'}
        </Text>
      </Text>
    </MessageResponse>
  )
}

/** Error renderer: delegate to the shared fallback. */
export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { verbose: boolean; progressMessagesForMessage?: unknown; tools?: unknown },
): React.ReactNode {
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}
