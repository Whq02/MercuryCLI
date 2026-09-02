import * as React from 'react'

import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { GLYPH } from '../../components/mercury-ui/glyphs.js'
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js'
import { Text } from '../../ink.js'
import type { ToolResultBlockParam } from '../../types/wire.js'
import { FILE_NOT_FOUND_CWD_NOTE, getDisplayPath } from '../../utils/file.js'
import { truncate } from '../../utils/format.js'
import { extractTag } from '../../utils/messages.js'
import { SearchResultSummary } from '../GrepTool/UI.js'
import type { Output } from './GlobTool.js'

/**
 * Glob renderers: the honest-count summary card, mirrored on the shared
 * search-summary component Grep owns.
 */

type GlobRenderInput = { pattern?: string; path?: string }

export function userFacingName(): string {
  return 'Search'
}

export function getToolUseSummary(input: GlobRenderInput | undefined): string | null {
  if (!input?.pattern) return null
  return truncate(input.pattern, TOOL_SUMMARY_MAX_LENGTH)
}

export function renderToolUseMessage(
  input: GlobRenderInput,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!input.pattern) return null
  if (input.path) {
    return (
      <Text>
        {input.pattern}
        <Text dimColor> in {verbose ? input.path : getDisplayPath(input.path)}</Text>
      </Text>
    )
  }
  return input.pattern
}

export function renderToolResultMessage(
  output: Output,
  _progressMessages: unknown,
  opts: { verbose: boolean; isTranscriptMode?: boolean },
): React.ReactNode {
  const { filenames } = output
  // The duration is a genuinely measured, persisted field (L3): omitted
  // rather than fabricated when absent, rounded to whole milliseconds.
  const trailer =
    typeof output.durationMs === 'number' && output.durationMs > 0
      ? `${Math.round(output.durationMs)}ms`
      : undefined
  // Verbose — or a transcript-mode click-expansion — reveals the actual
  // file list; collapsed mode keeps it as the body behind the affordance.
  const revealed = (opts.verbose && filenames.length > 0) || (opts.isTranscriptMode === true && filenames.length > 0)
  return (
    <SearchResultSummary
      count={output.numFiles}
      label="files"
      body={filenames.length > 0 ? filenames.join('\n') : undefined}
      verbose={revealed}
      {...(trailer !== undefined ? { trailer } : {})}
    />
  )
}

/** True exactly when there is a non-empty file list to reveal. */
export function isResultTruncated(output: Output | undefined): boolean {
  return Boolean(output && output.filenames.length > 0)
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
