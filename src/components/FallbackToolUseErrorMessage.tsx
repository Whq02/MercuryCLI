import type { ToolResultBlockParam } from '../types/wire.js'
import * as React from 'react'
import { stripUnderlineAnsi } from 'src/components/shell/OutputLine.js'
import { extractTag } from 'src/utils/messages.js'
import { removeSandboxViolationTags } from 'src/utils/sandbox/sandbox-ui-utils.js'
import { OUTPUT_CONNECTOR } from '../constants/figures.js'
import { Box, Text } from '../ink.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { classifyToolError } from '../utils/errors/classifyToolError.js'
import { isDenialResultText } from '../utils/messages/rejectionText.js'
import { countCharInString } from '../utils/stringUtils.js'
import { CtrlOToExpand } from './CtrlOToExpand.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { GLYPH } from './mercury-ui/glyphs.js'
import { MessageResponse } from './MessageResponse.js'

const MAX_RENDERED_LINES = 10

type Props = {
  result: ToolResultBlockParam['content']
  verbose: boolean
}

function contentText(result: ToolResultBlockParam['content']): string | null {
  if (typeof result === 'string') return result
  if (!Array.isArray(result)) return null
  const joined = result
    .map(block =>
      block &&
      typeof block === 'object' &&
      (block as { type?: string }).type === 'text' &&
      typeof (block as { text?: string }).text === 'string'
        ? (block as { text: string }).text
        : '',
    )
    .filter(text => text.trim() !== '')
    .join('\n')
  return joined.trim() === '' ? null : joined
}

function deriveDisplayedError(
  result: ToolResultBlockParam['content'],
  verbose: boolean,
): string {
  const text = contentText(result)
  if (text === null) {
    return 'Tool execution failed'
  }
  const extractedError = extractTag(text, 'tool_use_error') ?? text
  const withoutSandboxViolations = removeSandboxViolationTags(extractedError)
  const withoutErrorTags = withoutSandboxViolations.replace(/<\/?error>/g, '')
  const trimmed = withoutErrorTags.trim()
  if (!verbose && trimmed.includes('InputValidationError: ')) {
    return 'Invalid tool parameters'
  }
  if (trimmed.startsWith('Error: ') || trimmed.startsWith('Cancelled: ')) {
    return trimmed
  }
  return `Error: ${trimmed}`
}

export function isToolErrorResultTruncated(
  result: ToolResultBlockParam['content'],
): boolean {
  if (contentText(result) === null) return false
  const collapsed = deriveDisplayedError(result, false)
  if (collapsed !== deriveDisplayedError(result, true)) return true
  {
    const stripped = stripUnderlineAnsi(collapsed)
    const classified = classifyToolError(stripped)
    const fullBodyLines = classifyToolError(stripped, Number.MAX_SAFE_INTEGER)
      .bodyLines.length
    return (
      fullBodyLines - classified.bodyLines.length > 0 ||
      classified.stackFrameCount > 0
    )
  }
}

export function FallbackToolUseErrorMessage({
  result,
  verbose,
}: Props): React.ReactNode {
  const tokens = useMercuryTokens()
  const transcriptShortcut = useShortcutDisplay(
    'app:toggleTranscript',
    'Global',
    'ctrl+o',
  )
  const error = deriveDisplayedError(result, verbose)
  const rawText = contentText(result)
  const isDenied = rawText !== null && isDenialResultText(rawText)
  const headGlyph = isDenied ? GLYPH.fail : GLYPH.warn

  const plusLines = countCharInString(error, '\n') + 1 - MAX_RENDERED_LINES
  if (!verbose) {
    const stripped = stripUnderlineAnsi(error)
    const classified = classifyToolError(stripped)
    const hiddenLines =
      classifyToolError(stripped, Number.MAX_SAFE_INTEGER).bodyLines.length -
      classified.bodyLines.length
    return (
      <MessageResponse>
        <Box flexDirection="column">
          <Text color={isDenied ? tokens.failure : tokens.warning} bold>
            {headGlyph} {classified.firstLine}
          </Text>
          {classified.bodyLines.length > 0 && (
            <Text color={tokens.textMuted}>{classified.bodyLines.join('\n')}</Text>
          )}
          {hiddenLines > 0 && (
            <Text color={tokens.textMuted}>
              … +{hiddenLines} {hiddenLines === 1 ? 'line' : 'lines'}{' '}
              <CtrlOToExpand />
            </Text>
          )}
          {classified.stackFrameCount > 0 && (
            <Text color={tokens.textMuted}>
              {OUTPUT_CONNECTOR}+{classified.stackFrameCount} stack{' '}
              {classified.stackFrameCount === 1 ? 'frame' : 'frames'}{' '}
              <CtrlOToExpand />
            </Text>
          )}
          {classified.hint && (
            <Text color={tokens.textMuted}>
              {OUTPUT_CONNECTOR}
              {classified.hint}
            </Text>
          )}
        </Box>
      </MessageResponse>
    )
  }

  const body = stripUnderlineAnsi(
    verbose
      ? error
      : error.split('\n').slice(0, MAX_RENDERED_LINES).join('\n'),
  )

  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text color={isDenied ? 'error' : 'warning'}>
          {`${headGlyph} `}
          {body}
        </Text>
        {!verbose && plusLines > 0 && (
          <Box>
            <Text color={'subtle'} dimColor={false}>
              … +{plusLines} {plusLines === 1 ? 'line' : 'lines'} (
            </Text>
            <Text color={'subtle'} dimColor={false} bold>
              {transcriptShortcut}
            </Text>
            <Text> </Text>
            <Text color={'subtle'} dimColor={false}>
              to see all)
            </Text>
          </Box>
        )}
      </Box>
    </MessageResponse>
  )
}
