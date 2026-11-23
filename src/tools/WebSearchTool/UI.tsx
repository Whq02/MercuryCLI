import * as React from 'react'

import { Box, Text } from '../../ink.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { ToolCardMarker, ToolCardMeta, toolCardCountColor } from '../../components/mercury-ui/toolCardMeta.js'
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js'
import { viaChip } from '../../services/search/searchContract.js'
import type { ProgressMessage } from '../../types/message.js'
import type { WebSearchProgress } from '../../types/tools.js'
import { truncate } from '../../utils/format.js'
import { plural } from '../../utils/stringUtils.js'
import type { Output } from './WebSearchTool.js'

type Input = { query?: string; allowed_domains?: string[]; blocked_domains?: string[] }

export function renderToolUseMessage(input: Partial<Input>, { verbose }: { verbose: boolean }): React.ReactNode {
  if (!input.query) return null
  const quoted = `"${input.query}"`
  if (!verbose) return quoted
  return [
    quoted,
    ...(input.allowed_domains?.length ? [`allowed domains: ${input.allowed_domains.join(', ')}`] : []),
    ...(input.blocked_domains?.length ? [`blocked domains: ${input.blocked_domains.join(', ')}`] : []),
  ].join('\n')
}

function SearchProgress({ data }: { data: WebSearchProgress }): React.ReactElement | null {
  const tokens = useMercuryTokens()
  if (data.type === 'query_update') {
    return <Text color={tokens.textMuted}>Searching: {data.query}</Text>
  }
  if (data.type === 'search_results_received') {
    return (
      <Text color={tokens.textMuted}>
        {data.resultCount} {plural(data.resultCount, 'result')} for {data.query}
      </Text>
    )
  }
  return null
}

export function renderToolUseProgressMessage(
  progressMessages: ProgressMessage<WebSearchProgress>[],
): React.ReactNode {
  const last = progressMessages[progressMessages.length - 1]
  if (!last?.data) return null
  return <SearchProgress data={last.data} />
}

function formatDuration(seconds: number): string {
  return seconds >= 1 ? `${Math.round(seconds)}s` : `${Math.round(seconds * 1000)}ms`
}

function SearchResultLine({ output }: { output: Output }): React.ReactElement {
  const tokens = useMercuryTokens()
  let searchCount = 0
  let hitCount = 0
  for (const entry of output.results) {
    if (entry != null && typeof entry !== 'string') {
      searchCount += 1
      hitCount += entry.content.length
    }
  }
  const metaParts: string[] = [formatDuration(output.durationSeconds)]
  if (hitCount > 0) {
    metaParts.push(`${hitCount} ${plural(hitCount, 'result')}`)
  }
  if (output.via && output.tier) {
    metaParts.push(viaChip(output.via, output.tier))
  }
  if (output.cached) {
    metaParts.push('from the session cache')
  }
  const summary = (
    <MessageResponse height={1}>
      <Text>
        <ToolCardMarker />
        Did{' '}
        <Text bold color={toolCardCountColor()}>
          {searchCount}
        </Text>{' '}
        {plural(searchCount, 'search', 'searches')}
        <ToolCardMeta text={metaParts.join(' · ')} />
      </Text>
    </MessageResponse>
  )
  if (!output.hint) return summary
  return (
    <Box flexDirection="column">
      {summary}
      <MessageResponse height={1}>
        <Text color={tokens.textMuted}>{output.hint}</Text>
      </MessageResponse>
    </Box>
  )
}

export function renderToolResultMessage(output: Output): React.ReactNode {
  return <SearchResultLine output={output} />
}

export function getToolUseSummary(input: Partial<Input> | undefined): string | null {
  if (!input?.query) return null
  return truncate(input.query, TOOL_SUMMARY_MAX_LENGTH)
}
