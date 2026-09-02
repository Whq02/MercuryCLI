import * as React from 'react'

import { Box, Text } from '../../ink.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { ToolCardMarker, ToolCardMeta, toolCardCountColor } from '../../components/mercury-ui/toolCardMeta.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js'
import { formatFileSize, truncate } from '../../utils/format.js'
import type { Output } from './WebFetchTool.js'

/**
 * Transcript renderers for WebFetch. Design-system tokens throughout — no
 * colour literals.
 */

type Input = { url?: string; prompt?: string }

export function renderToolUseMessage(input: Partial<Input>, { verbose }: { verbose: boolean }): React.ReactNode {
  if (!input.url) return null
  if (!verbose) return input.url
  // INLINE BY LAW (prove-inline-render-safety): consumers embed this return
  // inside <Text> — the fetch permission card among them — and a Box nested
  // in a text node throws in the reconciler. A plain string always.
  return [`url: ${input.url}`, ...(input.prompt ? [`prompt: ${input.prompt}`] : [])].join('\n')
}

function FetchingIndicator(): React.ReactElement {
  return (
    <MessageResponse height={1}>
      <Text dimColor>Fetching…</Text>
    </MessageResponse>
  )
}

export function renderToolUseProgressMessage(): React.ReactNode {
  return <FetchingIndicator />
}

function FetchResult({ output, verbose }: { output: Output; verbose: boolean }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <MessageResponse height={1}>
        <Text>
          <ToolCardMarker />
          Received{' '}
          <Text bold color={toolCardCountColor()}>
            {formatFileSize(output.bytes)}
          </Text>
          <ToolCardMeta text={`${output.code} ${output.codeText}`} />
        </Text>
      </MessageResponse>
      {verbose ? <Text>{output.result}</Text> : null}
    </Box>
  )
}

export function renderToolResultMessage(output: Output, _progress: unknown, { verbose }: { verbose: boolean }): React.ReactNode {
  return <FetchResult output={output} verbose={verbose} />
}

/** The URL truncated to the shared tool-summary length, or nothing. */
export function getToolUseSummary(input: Partial<Input> | undefined): string | null {
  if (!input?.url) return null
  return truncate(input.url, TOOL_SUMMARY_MAX_LENGTH)
}
