import * as React from 'react'

import { Box, Text } from '../../ink.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { ToolCardMarker, ToolCardMeta, toolCardCountColor } from '../../components/mercury-ui/toolCardMeta.js'
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js'
import { viaChip, type SearchBackendId } from '../../services/search/searchContract.js'
import type { ProgressMessage } from '../../types/message.js'
import type { WebSearchProgress } from '../../types/tools.js'
import { truncate } from '../../utils/format.js'
import { plural } from '../../utils/stringUtils.js'
import type { Output } from './WebSearchTool.js'
import { notBuilt } from '../../pi/holes.js'

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

function SearchResultLine(arg0: { output: Output }): React.ReactElement {
  return notBuilt('src/tools/WebSearchTool/UI.tsx:55')
}

export function renderToolResultMessage(output: Output): React.ReactNode {
  return <SearchResultLine output={output} />
}

export function getToolUseSummary(input: Partial<Input> | undefined): string | null {
  if (!input?.query) return null
  return truncate(input.query, TOOL_SUMMARY_MAX_LENGTH)
}
