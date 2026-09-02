import * as React from 'react'

import { CtrlOToExpand } from '../../components/CtrlOToExpand.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { ToolCardMarker, ToolCardMeta, toolCardCountColor } from '../../components/mercury-ui/toolCardMeta.js'
import { GLYPH } from '../../components/mercury-ui/glyphs.js'
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js'
import { Box, Text } from '../../ink.js'
import type { ToolResultBlockParam } from '../../types/wire.js'
import { FILE_NOT_FOUND_CWD_NOTE } from '../../utils/file.js'
import { truncate } from '../../utils/format.js'
import { extractTag } from '../../utils/messages.js'

/**
 * Grep renderers, including the shared one-line search summary the Glob
 * renderer mirrors. Grep's Output type is deliberately not exported by the
 * tool; the renderer declares its own structurally-compatible shape.
 */

type GrepRenderOutput = {
  mode?: 'content' | 'files_with_matches' | 'count'
  numFiles: number
  filenames: string[]
  content?: string
  numLines?: number
  numMatches?: number
}

type GrepRenderInput = { pattern?: string; path?: string }

/**
 * Singularise a plural label for a count of exactly one; zero and plural
 * counts keep the plural form. `-es` plurals drop two characters — a
 * one-match search is common, and "matche" is not a word.
 */
function labelForCount(count: number, pluralLabel: string): string {
  if (count !== 1) return pluralLabel
  if (/(?:ches|shes|sses|xes|zes)$/.test(pluralLabel)) return pluralLabel.slice(0, -2)
  return pluralLabel.endsWith('s') ? pluralLabel.slice(0, -1) : pluralLabel
}

export type SearchResultSummaryProps = {
  count: number
  /** Plural label, singularised only for a count of exactly 1. */
  label: string
  secondaryCount?: number
  secondaryLabel?: string
  /** The expandable body: content lines or the file list. */
  body?: string
  /** Reveal the body (verbose mode or a transcript-mode expansion). */
  verbose: boolean
  /** A faint trailer rendered verbatim after the counts (L3-: Glob's
   *  measured duration rides here; Grep's rows pass none). */
  trailer?: string
}

/** The shared `Found N <label> [across M <label>]` summary line — marker
 *  and counts, plus a caller-supplied trailer rendered verbatim. */
export function SearchResultSummary({
  count,
  label,
  secondaryCount,
  secondaryLabel,
  body,
  verbose,
  trailer,
}: SearchResultSummaryProps): React.ReactNode {
  const tokens = useMercuryTokens()
  const hasBody = body !== undefined && body !== ''
  const summary = (
    <Text>
      <ToolCardMarker />
      Found{' '}
      <Text bold color={toolCardCountColor()}>
        {count}
      </Text>{' '}
      {labelForCount(count, label)}
      {secondaryCount !== undefined && secondaryLabel !== undefined ? (
        <Text>
          {' '}
          across{' '}
          <Text bold color={toolCardCountColor()}>
            {secondaryCount}
          </Text>{' '}
          {labelForCount(secondaryCount, secondaryLabel)}
        </Text>
      ) : null}
      <ToolCardMeta text={trailer} />
      {count > 0 && hasBody && !verbose ? (
        <Text color={tokens.textMuted}>
          {' '}
          <CtrlOToExpand />
        </Text>
      ) : null}
    </Text>
  )
  if (!verbose || !hasBody) {
    return <MessageResponse>{summary}</MessageResponse>
  }
  return (
    <MessageResponse>
      <Box flexDirection="column">
        {summary}
        <Box paddingLeft={2} flexDirection="column">
          <Text>{body}</Text>
        </Box>
      </Box>
    </MessageResponse>
  )
}

export function getToolUseSummary(input: GrepRenderInput | undefined): string | null {
  if (!input?.pattern) return null
  return truncate(input.pattern, TOOL_SUMMARY_MAX_LENGTH)
}

export function renderToolUseMessage(
  input: GrepRenderInput,
  _options: { verbose: boolean },
): React.ReactNode {
  if (!input.pattern) return null
  if (input.path) {
    return (
      <Text>
        {input.pattern}
        <Text dimColor> in {input.path}</Text>
      </Text>
    )
  }
  return input.pattern
}

export function renderToolResultMessage(
  output: GrepRenderOutput,
  _progressMessages: unknown,
  { verbose, isTranscriptMode }: { verbose: boolean; isTranscriptMode?: boolean },
): React.ReactNode {
  // A transcript-mode expansion (click-to-expand) reveals exactly what
  // verbose reveals.
  const revealed = verbose || isTranscriptMode === true
  switch (output.mode) {
    case 'content':
      return (
        <SearchResultSummary
          count={output.numLines ?? 0}
          label="lines"
          body={output.content}
          verbose={revealed}
        />
      )
    case 'count':
      return (
        <SearchResultSummary
          count={output.numMatches ?? 0}
          label="matches"
          secondaryCount={output.numFiles}
          secondaryLabel="files"
          body={output.content}
          verbose={revealed}
        />
      )
    default:
      return (
        <SearchResultSummary
          count={output.numFiles}
          label="files"
          body={output.filenames.join('\n')}
          verbose={revealed}
        />
      )
  }
}

export function isResultTruncated(output: GrepRenderOutput | undefined): boolean {
  if (!output) return false
  switch (output.mode) {
    case 'content':
      return (output.numLines ?? 0) > 0 && Boolean(output.content)
    case 'count':
      return (output.numMatches ?? 0) > 0 && Boolean(output.content)
    default:
      return output.numFiles > 0 && output.filenames.length > 0
  }
}

function ShortErrorLine({ text }: { text: string }): React.ReactNode {
  const tokens = useMercuryTokens()
  return (
    <MessageResponse>
      <Text color={tokens.warning}>
        {GLYPH.warn} {text}
      </Text>
    </MessageResponse>
  )
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!verbose && typeof result === 'string') {
    const extracted = extractTag(result, 'tool_use_error')
    if (extracted !== null) {
      if (extracted.includes(FILE_NOT_FOUND_CWD_NOTE)) {
        return <ShortErrorLine text="File not found" />
      }
      return <ShortErrorLine text="Error searching files" />
    }
  }
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}
