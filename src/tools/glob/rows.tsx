import * as React from 'react'

import { FallbackToolUseErrorMessage, ShortErrorLine } from '../kit/FallbackToolUseErrorMessage.js'
import { isDenialResultText } from '../../engine/message-shapes/rejectionText.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../kit/toolLimits.js'
import { Text } from '../../screen/themedRenderer.js'
import type { ToolResultBlockParam } from '../../engine/message-shapes/wire.js'
import { FILE_NOT_FOUND_CWD_NOTE, getDisplayPath } from '../../platform/files/file.js'
import { truncate } from '../../platform/text/format.js'
import { extractTag } from '../../engine/messages/messages.js'
import { SearchResultSummary } from '../grep/rows.js'
import type { Output } from './GlobTool.js'
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

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!verbose && typeof result === 'string' && !isDenialResultText(result)) {
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
