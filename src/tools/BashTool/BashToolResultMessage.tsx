import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { FAINT } from '../../components/mercuryPalette.js'
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { OutputLine } from '../../components/shell/OutputLine.js'
import { ShellTimeDisplay } from '../../components/shell/ShellTimeDisplay.js'
import { ToolCardMarker, ToolCardMeta } from '../../components/mercury-ui/toolCardMeta.js'
import { removeSandboxViolationTags } from '../../utils/sandbox/sandbox-ui-utils.js'
import { formatFileSize } from '../../utils/format.js'

/** The completed-result shape this component renders (the output type minus `interrupted`). */
type BashResultContent = {
  stdout: string
  stderr: string
  isImage?: boolean
  backgroundTaskId?: string
  noOutputExpected?: boolean
  returnCodeInterpretation?: string
  persistedOutputSize?: number
}

/** Detects the shell-cwd-reset notice at the end of the stderr field (S03's contract text). */
const CWD_RESET_NOTICE = /(?:^|\n)Shell cwd was reset to [^\n]*$/

/**
 * Render a finished Bash result in the terminal. Interrupted results never
 * reach here — they route through the error renderer — so anything shown here
 * completed.
 */
export default function BashToolResultMessage({
  content,
  verbose,
  timeoutMs,
}: {
  content: BashResultContent
  verbose: boolean
  timeoutMs?: number
}): React.ReactNode {
  const stdout = content.stdout ?? ''

  // A full sandbox-violation block is surfaced elsewhere: drop it from the text.
  const stderrWithoutViolations = removeSandboxViolationTags(content.stderr ?? '')

  // A cwd-reset notice is rendered as a dimmed warning, not an error.
  const resetMatch = stderrWithoutViolations.match(CWD_RESET_NOTICE)
  const cwdResetNotice = resetMatch ? resetMatch[0].replace(/^\n/, '') : null
  const remainingStderr = resetMatch
    ? stderrWithoutViolations.slice(0, resetMatch.index).trimEnd()
    : stderrWithoutViolations

  // An image result replaces the whole body (including the timeout display).
  if (content.isImage) {
    return (
      <Text color={FAINT} dimColor>
        [image data detected and sent to the model]
      </Text>
    )
  }

  const stdoutEmpty = stdout.trim() === ''
  const stderrBlank = remainingStderr.trim() === ''
  const showEmptyRow = stdoutEmpty && stderrBlank && !cwdResetNotice

  return (
    <Box flexDirection="column">
      {!stdoutEmpty && <OutputLine content={stdout} verbose={verbose} />}
      {!stderrBlank && <OutputLine content={remainingStderr} verbose={verbose} isError />}
      {cwdResetNotice && <OutputLine content={cwdResetNotice} verbose={verbose} isWarning />}
      {showEmptyRow && <EmptyRow content={content} />}
      {typeof timeoutMs === 'number' && timeoutMs > 0 && <ShellTimeDisplay timeoutMs={timeoutMs} />}
    </Box>
  )
}

/** The empty-result row: a background line, or the card marker plus an honest note. */
function EmptyRow({ content }: { content: BashResultContent }): React.ReactNode {
  if (content.backgroundTaskId) {
    return (
      <MessageResponse height={1}>
        <Text color={FAINT} dimColor>
          Running in the background <KeyboardShortcutHint shortcut="↓" action="manage" parens />
        </Text>
      </MessageResponse>
    )
  }

  // Precedence: return-code interpretation, else success word (silent command),
  // else the no-output notice. Nothing else may be fabricated here.
  const note = content.returnCodeInterpretation
    ? content.returnCodeInterpretation
    : content.noOutputExpected
      ? 'Done'
      : 'No output'
  const meta =
    typeof content.persistedOutputSize === 'number' && content.persistedOutputSize > 0
      ? formatFileSize(content.persistedOutputSize)
      : undefined

  return (
    <MessageResponse height={1}>
      <Text>
        <ToolCardMarker />
        <Text color={FAINT} dimColor>
          {note}
        </Text>
        <ToolCardMeta text={meta} />
      </Text>
    </MessageResponse>
  )
}
