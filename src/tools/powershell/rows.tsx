import * as React from 'react'
import { Box, Text } from '../../screen/themedRenderer.js'
import { oneLineCommandDisplay } from '../kit/commandDisplay.js'
import { FAINT } from '../../screen/theme/mercuryPalette.js'
import { FallbackToolUseErrorMessage } from '../kit/FallbackToolUseErrorMessage.js'
import { MessageResponse } from '../kit/MessageResponse.js'
import { ShellProgressMessage } from '../../screen/shell-output/ShellProgressMessage.js'
import { ShellTimeDisplay } from '../../screen/shell-output/ShellTimeDisplay.js'
import { OutputLine } from '../../screen/shell-output/OutputLine.js'
import { ToolCardMarker } from '../../screen/widgets/toolCardMeta.js'
import { KeyboardShortcutHint } from '../../screen/theme/KeyboardShortcutHint.js'
import { DOWN_ARROW } from '../../screen/theme/rowGlyphs.js'
import type { ProgressMessage } from '../../engine/message-shapes/message.js'
import type { PowerShellProgress } from '../kit/toolProgress.js'
import type { ToolResultBlockParam } from '../../engine/message-shapes/wire.js'

export function renderToolUseMessage(input: Partial<{ command?: string; description?: string }>, { verbose }: { verbose: boolean; theme?: unknown }): React.ReactNode {
  const command = input.command
  if (!command) return null
  if (verbose) return command
  return <Text>{oneLineCommandDisplay(command)}</Text>
}

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

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { verbose: boolean; progressMessagesForMessage?: unknown; tools?: unknown },
): React.ReactNode {
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}
