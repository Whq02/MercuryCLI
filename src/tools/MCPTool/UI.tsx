import * as React from 'react'

import { ProgressBar } from '../../components/design-system/ProgressBar.js'
import { OutputLine } from '../../components/shell/OutputLine.js'
import { Ansi } from '../../ink/Ansi.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { GLYPH } from '../../components/mercury-ui/glyphs.js'
import { Box, Text } from '../../ink.js'
import type { ProgressMessage } from '../../types/message.js'
import type { MCPProgress } from '../../types/tools.js'
import { formatNumber } from '../../utils/format.js'
import { createHyperlink } from '../../utils/hyperlink.js'
import { getContentSizeEstimate, type MCPToolResult } from '../../utils/mcpValidation.js'

/**
 * Renderers for MCP tool use, progress and results, plus the Slack
 * "message sent" recogniser the result path compacts on.
 */

/** Responses above this many estimated tokens get the large-response warning. */
const LARGE_RESPONSE_TOKEN_THRESHOLD = 10_000

/** Cells in the determinate progress bar. */
const PROGRESS_BAR_WIDTH = 20

// ── header ──────────────────────────────────────────────────────────────────

/**
 * Every top-level entry as `key: <json-encoded value>` joined by `, `; the
 * empty string for an input with no keys. Verbosity is accepted but not
 * read, and values are never truncated.
 */
export function renderToolUseMessage(
  input: Record<string, unknown> | undefined,
  _options: { verbose: boolean },
): React.ReactNode {
  const entries = Object.entries(input ?? {})
  if (entries.length === 0) return ''
  return entries.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(', ')
}

// ── progress ────────────────────────────────────────────────────────────────

export function renderToolUseProgressMessage(
  progressMessages: ProgressMessage<MCPProgress>[],
): React.ReactNode {
  const latest = progressMessages[progressMessages.length - 1]?.data
  if (!latest || typeof latest.progress !== 'number') {
    return (
      <MessageResponse height={1}>
        <Text dimColor>Running…</Text>
      </MessageResponse>
    )
  }
  const { progress, total, progressMessage } = latest
  if (typeof total === 'number' && total > 0) {
    const ratio = Math.min(1, Math.max(0, progress / total))
    return (
      <MessageResponse>
        <Box flexDirection="column">
          {progressMessage ? <Ansi dimColor>{progressMessage}</Ansi> : null}
          <Box>
            <ProgressBar width={PROGRESS_BAR_WIDTH} ratio={ratio} />
            <Text> {Math.round(ratio * 100)}%</Text>
          </Box>
        </Box>
      </MessageResponse>
    )
  }
  // MCP servers stream progress text that may carry ANSI styling; the
  // message renders through the ANSI-aware text component (census mount).
  if (progressMessage) {
    return (
      <MessageResponse height={1}>
        <Ansi dimColor>{progressMessage}</Ansi>
      </MessageResponse>
    )
  }
  return (
    <MessageResponse height={1}>
      <Text dimColor>{`Processing… (${progress})`}</Text>
    </MessageResponse>
  )
}

// ── Slack send compaction ───────────────────────────────────────────────────

/** The `message_link` result key, quoted, that a Slack "message sent" payload carries (contract data). */
const MESSAGE_LINK_TOKEN = '"message_link"'

/** A Slack archive permalink, matched whole (contract data). */
const SLACK_PERMALINK = /^https:\/\/[a-z0-9-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p\d+$/

const SLACK_PAYLOAD_MAX_KEYS = 6
const SLACK_PAYLOAD_MAX_CHARS = 2_000

function candidateText(output: MCPToolResult): string | undefined {
  if (typeof output === 'string') return output
  if (!Array.isArray(output)) return undefined
  const firstText = output.find(block => block.type === 'text') as { text?: unknown } | undefined
  return typeof firstText?.text === 'string' ? firstText.text : undefined
}

/**
 * Recognise a Slack "message sent" payload and derive its display channel
 * (from the tool input's `channel_id`, then `channel`, then the id parsed out
 * of the permalink, then the literal `slack`) and URL. Null when the payload
 * is anything else.
 */
export function trySlackSendCompact(
  output: MCPToolResult,
  input: unknown,
): { channel: string; url: string } | null {
  const text = candidateText(output)
  if (text === undefined || !text.includes(MESSAGE_LINK_TOKEN)) return null
  if (text.length > SLACK_PAYLOAD_MAX_CHARS) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (Object.keys(record).length > SLACK_PAYLOAD_MAX_KEYS) return null
  const link = record.message_link
  if (typeof link !== 'string') return null
  const match = SLACK_PERMALINK.exec(link)
  if (!match) return null

  const inputRecord =
    input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const chosen: unknown =
    inputRecord.channel_id !== undefined && inputRecord.channel_id !== null
      ? inputRecord.channel_id
      : inputRecord.channel !== undefined && inputRecord.channel !== null
        ? inputRecord.channel
        : match[1]
  const label = typeof chosen === 'string' && chosen.length > 0 ? chosen : 'slack'
  return { channel: label.startsWith('#') ? label : `#${label}`, url: link }
}

// ── result ──────────────────────────────────────────────────────────────────

function ImagePlaceholder(): React.ReactNode {
  return (
    <MessageResponse height={1}>
      <Box width="100%">
        <Text>[Image]</Text>
      </Box>
    </MessageResponse>
  )
}

function ContentBlocks({
  blocks,
  verbose,
}: {
  blocks: ReadonlyArray<{ type: string; text?: unknown }>
  verbose: boolean
}): React.ReactNode {
  return (
    <Box flexDirection="column">
      {blocks.map((block, index) => {
        if (block.type === 'image') return <ImagePlaceholder key={index} />
        // Only a text-typed block paints its text field; any other block
        // type renders an empty line even when it carries a `text` field.
        const text =
          block.type === 'text' && block.text !== undefined && block.text !== null
            ? String(block.text)
            : ''
        return (
          <MessageResponse key={index}>
            <OutputLine content={text} verbose={verbose} />
          </MessageResponse>
        )
      })}
    </Box>
  )
}

export function renderToolResultMessage(
  output: MCPToolResult,
  _progressMessages: unknown,
  { verbose, input }: { verbose: boolean; input?: unknown },
): React.ReactNode {
  if (!verbose) {
    const compact = trySlackSendCompact(output, input)
    if (compact) {
      return (
        <MessageResponse height={1}>
          <Text>Message sent to {createHyperlink(compact.url, compact.channel)}</Text>
        </MessageResponse>
      )
    }
  }

  const estimate = getContentSizeEstimate(output)
  const warning =
    estimate > LARGE_RESPONSE_TOKEN_THRESHOLD ? (
      <MessageResponse height={1}>
        <Text color="warning">
          {GLYPH.warn} Large MCP response (~{formatNumber(estimate)} tokens) — responses this size eat context fast
        </Text>
      </MessageResponse>
    ) : null

  let body: React.ReactNode
  if (Array.isArray(output)) {
    body = <ContentBlocks blocks={output as ReadonlyArray<{ type: string; text?: unknown }>} verbose={verbose} />
  } else if (!output) {
    body = (
      <MessageResponse height={1}>
        <Text dimColor>(No content)</Text>
      </MessageResponse>
    )
  } else {
    body = (
      <MessageResponse>
        <OutputLine content={output} verbose={verbose} />
      </MessageResponse>
    )
  }

  if (!warning) return body
  return (
    <Box flexDirection="column">
      {warning}
      {body}
    </Box>
  )
}
