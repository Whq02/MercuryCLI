import type { ToolResultBlockParam } from '../../engine/message-shapes/wire.js'
import * as React from 'react'
import stripAnsi from 'strip-ansi'
import { extractTag } from 'src/engine/messages/messages.js'
import { OUTPUT_CONNECTOR } from '../../screen/theme/rowGlyphs.js'
import { Box, Text } from '../../screen/themedRenderer.js'
import { classifyToolError } from '../../engine/tool-errors/classifyToolError.js'
import { DENIAL_WORKAROUND_GUIDANCE, denialLineOf, isDenialResultText, unwrapToolUseError } from '../../engine/message-shapes/rejectionText.js'
import { CtrlOToExpand } from '../../screen/messages/CtrlOToExpand.js'
import { useMercuryTokens } from '../../screen/widgets/useMercuryTokens.js'
import { GLYPH } from '../../screen/theme/glyphs.js'
import { MessageResponse } from './MessageResponse.js'

type Props = {
  result: ToolResultBlockParam['content']
  verbose: boolean
}

function contentText(result: ToolResultBlockParam['content']): string | null {
  if (typeof result === 'string') return stripAnsi(result)
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
  return joined.trim() === '' ? null : stripAnsi(joined)
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
  const withoutErrorTags = extractedError.replace(/<\/?error>/g, '')
  const trimmed = withoutErrorTags.trim()
  if (trimmed.startsWith('Error: ') || trimmed.startsWith('Cancelled: ')) {
    return trimmed
  }
  return `Error: ${trimmed}`
}

export function FallbackToolUseErrorMessage({
  result,
  verbose,
}: Props): React.ReactNode {
  const tokens = useMercuryTokens()
  const error = deriveDisplayedError(result, verbose)
  const rawText = contentText(result)
  const isDenied = rawText !== null && isDenialResultText(rawText)
  const headGlyph = isDenied ? GLYPH.fail : GLYPH.warn

  if (isDenied) {
    return (
      <MessageResponse>
        <Text color={tokens.failure} bold>
          {headGlyph} {verbose ? unwrapToolUseError(rawText).replace(DENIAL_WORKAROUND_GUIDANCE, '').trim() : denialLineOf(rawText)}
        </Text>
      </MessageResponse>
    )
  }

  if (!verbose) {
    const classified = classifyToolError(error)
    const hiddenLines =
      classifyToolError(error, Number.MAX_SAFE_INTEGER).bodyLines.length -
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

  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text color={isDenied ? 'error' : 'warning'}>
          {`${headGlyph} `}
          {error}
        </Text>
      </Box>
    </MessageResponse>
  )
}
