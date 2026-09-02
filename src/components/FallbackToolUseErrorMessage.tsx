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

/** Normalise tool_result content to displayable text: strings pass through;
 *  block arrays join their text blocks (the Agent tool's failure results ride
 *  block arrays — collapsing them to a constant hid the honest
 *  "Agent execution failed: …" reason from the transcript while the model
 *  still saw it, the flow-incident presentation defect). Null when
 *  no text exists to show. */
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

/** The displayed error text for a raw tool_result content — extracted from the
 *  component so isToolErrorResultTruncated below gates on EXACTLY what renders
 *  (a mirrored copy would drift). */
function deriveDisplayedError(
  result: ToolResultBlockParam['content'],
  verbose: boolean,
): string {
  const text = contentText(result)
  if (text === null) {
    return 'Tool execution failed'
  }
  const extractedError = extractTag(text, 'tool_use_error') ?? text
  // Remove sandbox_violations tags from error display (Claude still sees them in the tool result)
  const withoutSandboxViolations = removeSandboxViolationTags(extractedError)
  // Strip <error> tags but keep their content (tags are for the model, not the UI)
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

/** Gates fullscreen click-to-expand for ERROR tool results — there is no tool
 *  Output to consult (isResultTruncated), so the fold owner decides: true
 *  exactly when the collapsed render hides content verbose reveals (Mercury
 *  card's body-cap / stack-frame folds, the InputValidationError one-liner,
 *  or the legacy +N-lines cap). Tools whose custom error renderer ignores
 *  `verbose` entirely (null / constant-line renderers) draw no foldable body,
 *  so a rare over-true here costs a bg highlight, never a dead promise. */
export function isToolErrorResultTruncated(
  result: ToolResultBlockParam['content'],
): boolean {
  if (contentText(result) === null) return false // fixed line; verbose identical
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
  // The error-card headline honors the SAME denial split as the tool status
  // glyph: the CRIMSON ✕ is reserved for a
  // DENIAL — a rejected permission, an interrupt, a kill — where the operator
  // said no and the transcript should say so loudly. An ordinary tool failure
  // (a non-zero bash exit, an ENOENT) is work-in-progress, so it wears the
  // AMBER ▲ warn lead — half the transcript never reads as an alarm. Classify
  // on the RAW result text (the denial canon lives there pre-derive);
  // block-array results classify on their joined text.
  const rawText = contentText(result)
  const isDenied = rawText !== null && isDenialResultText(rawText)
  const headGlyph = isDenied ? GLYPH.fail : GLYPH.warn

  const plusLines = countCharInString(error, '\n') + 1 - MAX_RENDERED_LINES
  // Fork (collapsed view): the classified card — `✕/▲ <headline>` bold in the
  // matching tone, the body FAINT, stack frames FOLDED into a `└ +N stack
  // frames` row instead of painted raw, and a `└ <one-line fix>` for the known
  // errno classes. The full raw text stays reachable exactly where it was:
  // verbose (ctrl+o) falls through to the legacy path below, uncapped.
  if (!verbose) {
    const stripped = stripUnderlineAnsi(error)
    const classified = classifyToolError(stripped)
    // Non-frame lines hidden by the body cap (frames have their own fold row).
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
          // The careful <Text> layout is a workaround for the dim-bold
          // rendering bug
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
