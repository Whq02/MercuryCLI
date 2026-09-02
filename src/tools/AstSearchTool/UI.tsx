import * as React from 'react'

import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { GLYPH } from '../../components/mercury-ui/glyphs.js'
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js'
import { Text } from '../../ink.js'
import type { ToolResultBlockParam } from '../../types/wire.js'
import { FILE_NOT_FOUND_CWD_NOTE } from '../../utils/file.js'
import { truncate } from '../../utils/format.js'
import { extractTag } from '../../utils/messages.js'
import { SearchResultSummary } from '../GrepTool/UI.js'

/**
 * AstSearch renderers: the one-line search summary Grep and Glob share
 * (counts + an expandable body), keyed on matches and files.
 */

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
  if (!verbose && typeof result === 'string') {
    const extracted = extractTag(result, 'tool_use_error')
    if (extracted !== null) {
      if (extracted.includes(FILE_NOT_FOUND_CWD_NOTE)) return <ShortErrorLine text="File not found" />
      if (extracted.startsWith('The pattern ')) return <ShortErrorLine text="Pattern did not parse" />
      return <ShortErrorLine text="Error searching structurally" />
    }
  }
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}
