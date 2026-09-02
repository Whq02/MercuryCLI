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

type Input = { query?: string; allowed_domains?: string[]; blocked_domains?: string[] }

export function renderToolUseMessage(input: Partial<Input>, { verbose }: { verbose: boolean }): React.ReactNode {
  if (!input.query) return null
  const quoted = `"${input.query}"`
  if (!verbose) return quoted
  // INLINE BY LAW (prove-inline-render-safety): consumers embed this return
  // inside <Text> — the generic permission card among them — and a Box
  // nested in a text node throws in the reconciler. A plain string always.
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

/** Reads the LAST progress message; nothing recognisable renders nothing. */
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
  // Both counts derive from the persisted results array — never fabricated.
  const searchEntries = output.results.filter(
    (entry): entry is Extract<Output['results'][number], { tool_use_id: string }> =>
      entry !== null && entry !== undefined && typeof entry !== 'string',
  )
  const searchCount = searchEntries.length
  const hitCount = searchEntries.reduce((sum, entry) => sum + entry.content.length, 0)
  // The row names the door that answered (results persisted before the
  // door existed carry no `via` and print none).
  const via = output.via && output.tier ? ` · ${viaChip(output.via as SearchBackendId, output.tier)}` : ''
  const meta = `${formatDuration(output.durationSeconds)}${
    hitCount > 0 ? ` · ${hitCount} ${plural(hitCount, 'result')}` : ''
  }${via}`
  return (
    <MessageResponse height={1}>
      <Text>
        <ToolCardMarker />
        Did{' '}
        <Text bold color={toolCardCountColor()}>
          {searchCount}
        </Text>{' '}
        {plural(searchCount, 'search', 'searches')}
        <ToolCardMeta text={meta} />
      </Text>
    </MessageResponse>
  )
}

export function renderToolResultMessage(output: Output): React.ReactNode {
  return <SearchResultLine output={output} />
}

export function getToolUseSummary(input: Partial<Input> | undefined): string | null {
  if (!input?.query) return null
  return truncate(input.query, TOOL_SUMMARY_MAX_LENGTH)
}
