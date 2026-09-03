// Advisor server-tool-use and advisor-result rows. The advisor reviews the
// conversation out of band; its header shows the loader plus the advisor
// model, and its result folds behind ctrl+o unless verbose (a redacted
// result keeps the one-liner and loses the expansion affordance).

import { GLYPH } from '../mercury-ui/glyphs.js'
import React from 'react'
import { Box, Text } from '../../ink.js'
import { CtrlOToExpand } from '../CtrlOToExpand.js'
import { ToolUseLoader } from '../ToolUseLoader.js'

type AdvisorBlock = {
  id?: string
  name?: string
  input?: unknown
  content?: unknown
  is_error?: boolean
  error_code?: string
  redacted?: boolean
  text?: string
}

function advisorText(block: AdvisorBlock): string {
  if (typeof block.text === 'string') return block.text
  if (typeof block.content === 'string') return block.content
  if (Array.isArray(block.content)) {
    return (block.content as Array<{ type?: string; text?: string }>)
      .filter(part => part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text as string)
      .join('\n')
  }
  return ''
}

export function AdvisorMessage({
  block,
  addMargin = false,
  resolvedToolUseIDs,
  erroredToolUseIDs,
  shouldAnimate = false,
  verbose = false,
  advisorModel,
}: {
  block: AdvisorBlock & { type?: string }
  addMargin?: boolean
  resolvedToolUseIDs: Set<string>
  erroredToolUseIDs: Set<string>
  shouldAnimate?: boolean
  verbose?: boolean
  advisorModel?: string | null
}): React.ReactNode {
  const isResult =
    block.type === 'server_tool_result' || block.content !== undefined || block.is_error

  if (!isResult) {
    const id = block.id ?? ''
    const resolved = resolvedToolUseIDs.has(id)
    const errored = erroredToolUseIDs.has(id)
    const input =
      block.input !== null &&
      typeof block.input === 'object' &&
      Object.keys(block.input as object).length > 0
        ? JSON.stringify(block.input)
        : null
    return (
      <Box marginTop={addMargin ? 1 : 0}>
        {/* Box-returning leaf: a row sibling, never inside the Text. */}
        <ToolUseLoader
          isError={errored}
          isUnresolved={!resolved}
          shouldAnimate={shouldAnimate && !resolved}
        />
        <Text wrap="truncate-end">
          {' '}
          <Text bold>Advisor reviewing</Text>
          {advisorModel ? <Text dimColor> {advisorModel}</Text> : null}
          {input ? <Text dimColor> {input}</Text> : null}
        </Text>
      </Box>
    )
  }

  if (block.is_error) {
    return (
      <Text color="error">
        Advisor unavailable{block.error_code ? ` (${block.error_code})` : ''}.
      </Text>
    )
  }

  const text = advisorText(block)
  if (verbose && !block.redacted) {
    return (
      <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
        <Text>
          <Text color="success">{GLYPH.check} </Text>
          Advisor feedback:
        </Text>
        <Box paddingLeft={2}>
          <Text dimColor>{text}</Text>
        </Box>
      </Box>
    )
  }
  return (
    <Text>
      <Text color="success">{GLYPH.check} </Text>
      <Text dimColor>
        The advisor reviewed the conversation; its feedback will be applied.
      </Text>
      {!block.redacted ? (
        <>
          {' '}
          <CtrlOToExpand />
        </>
      ) : null}
    </Text>
  )
}

export default AdvisorMessage
