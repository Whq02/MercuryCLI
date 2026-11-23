import * as React from 'react'

import { FallbackToolUseErrorMessage } from '../kit/FallbackToolUseErrorMessage.js'
import { isDenialResultText } from '../../engine/message-shapes/rejectionText.js'
import { MessageResponse } from '../kit/MessageResponse.js'
import { GLYPH } from '../../screen/theme/glyphs.js'
import { useMercuryTokens } from '../../screen/widgets/useMercuryTokens.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../kit/toolLimits.js'
import { Text } from '../../screen/themedRenderer.js'
import type { ToolResultBlockParam } from '../../engine/message-shapes/wire.js'
import { FILE_NOT_FOUND_CWD_NOTE } from '../../platform/files/file.js'
import { truncate } from '../../platform/text/format.js'
import { extractTag } from '../../engine/messages/messages.js'
import { SearchResultSummary } from '../grep/rows.js'


type RenderOutput = {
  mode: 'matches' | 'count'
  text: string
  matchCount: number
  fileCount: number
  shown: number
  truncated: boolean
  capped: boolean
}

type RenderInput = { pattern?: string; path?: string; glob?: string; lang?: string; mode?: string }

export function getToolUseSummary(input: RenderInput | undefined): string | null {
  if (!input?.pattern) return null
  return truncate(input.pattern, TOOL_SUMMARY_MAX_LENGTH)
}

export function renderToolUseMessage(input: RenderInput, _options: { verbose: boolean }): React.ReactNode {
  if (!input.pattern) return null
  const where = [input.path, input.glob, input.lang].filter(Boolean).join(' ')
  return (
    <Text>
      {input.pattern}
      {where ? <Text dimColor> in {where}</Text> : null}
      {input.mode === 'count' ? <Text dimColor> (count)</Text> : null}
    </Text>
  )
}

export function renderToolResultMessage(
  output: RenderOutput,
  _progressMessages: unknown,
  { verbose, isTranscriptMode }: { verbose: boolean; isTranscriptMode?: boolean },
): React.ReactNode {
  const revealed = verbose || isTranscriptMode === true
  return (
    <SearchResultSummary
      count={output.matchCount}
      label="matches"
      secondaryCount={output.fileCount}
      secondaryLabel="files"
      body={output.text}
      verbose={revealed}
      trailer={output.capped ? 'bound reached' : undefined}
    />
  )
}

export function isResultTruncated(output: RenderOutput | undefined): boolean {
  if (!output) return false
  return output.matchCount > 0 && Boolean(output.text)
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
  if (!verbose && typeof result === 'string' && !isDenialResultText(result)) {
    const extracted = extractTag(result, 'tool_use_error')
    if (extracted !== null) {
      if (extracted.includes(FILE_NOT_FOUND_CWD_NOTE)) return <ShortErrorLine text="File not found" />
      if (extracted.startsWith('The pattern ')) return <ShortErrorLine text="Pattern did not parse" />
      return <ShortErrorLine text="Error searching structurally" />
    }
  }
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}
