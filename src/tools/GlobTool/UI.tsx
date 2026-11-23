import * as React from 'react'

import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js'
import { Text } from '../../ink.js'
import { getDisplayPath } from '../../utils/file.js'
import { truncate } from '../../utils/format.js'
import { SearchResultSummary, renderToolUseErrorMessage } from '../GrepTool/UI.js'
import type { Output } from './GlobTool.js'

export { renderToolUseErrorMessage }

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
    const shown = verbose ? input.path : getDisplayPath(input.path)
    return (
      <Text>
        {input.pattern}
        <Text dimColor> in {shown}</Text>
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
  const revealed = (opts.verbose || opts.isTranscriptMode === true) && output.filenames.length > 0
  return (
    <SearchResultSummary
      count={output.numFiles}
      label="files"
      body={output.filenames.length > 0 ? output.filenames.join('\n') : undefined}
      verbose={revealed}
      trailer={output.durationMs > 0 ? `${Math.round(output.durationMs)}ms` : undefined}
    />
  )
}

export function isResultTruncated(output: Output | undefined): boolean {
  if (!output) return false
  return output.filenames.length > 0
}
