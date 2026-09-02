// One block of command output: JSON pretty-print (lossless only),
// opt-in URL linkify, display truncation (unless verbose or inside an
// expand-shell-output subtree), and underline-SGR scrubbing — only
// underline, deliberately. Colour: error role, warning role, or unstyled.

import React, { useContext } from 'react'
import { Ansi, Text } from '../../ink.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { MessageResponse } from '../MessageResponse.js'
import { InVirtualListContext } from '../messageActions.js'
import { useExpandShellOutput } from './ExpandShellOutputContext.js'

const JSON_PASS_MAX_CHARS = 10_000

/** Pretty-print one line of JSON with 2-space indentation, only when the
 *  round-trip is lossless (large-integer precision loss returns the
 *  original untouched). */
export function tryFormatJson(line: string): string {
  if (line.length > JSON_PASS_MAX_CHARS) return line
  const trimmed = line.trim()
  if (trimmed === '') return line
  try {
    const parsed = JSON.parse(trimmed)
    const compact = JSON.stringify(parsed)
    if (compact === undefined) return line
    const originalComparable = trimmed
      .replace(/\\\//g, '/')
      .replace(/\s+/g, '')
    const compactComparable = compact.replace(/\s+/g, '')
    if (originalComparable !== compactComparable) return line
    return JSON.stringify(parsed, null, 2)
  } catch {
    return line
  }
}

/** Apply the JSON pass per line; content over the cap skips the pass. */
export function tryJsonFormatContent(content: string): string {
  if (content.length > JSON_PASS_MAX_CHARS) return content
  return content
    .split('\n')
    .map(line => tryFormatJson(line))
    .join('\n')
}

/** HTTP/HTTPS URLs become terminal hyperlinks. The pattern is deliberately
 *  conservative — no quotes, whitespace, angle brackets or backslashes —
 *  so JSON structure is not swallowed. */
export function linkifyUrlsInText(content: string): string {
  return content.replace(
    /https?:\/\/[^\s"'<>\\]+/g,
    url => `\u001b]8;;${url}\u0007${url}\u001b]8;;\u0007`,
  )
}

/** Strip underline SGR in all three positional forms (leading, trailing,
 *  standalone). Only underline — other formatting survives. */
export function stripUnderlineAnsi(content: string): string {
  return content
    .replace(/\u001b\[4;/g, '\u001b[')
    .replace(/\u001b\[([0-9;]*);4m/g, '\u001b[$1m')
    .replace(/\u001b\[4m/g, '')
}

const DISPLAY_LINE_CAP = 10
const VIRTUAL_LIST_LINE_CAP = 25

function truncateForDisplay(
  content: string,
  inVirtualList: boolean,
): { text: string; hidden: number } {
  const cap = inVirtualList ? VIRTUAL_LIST_LINE_CAP : DISPLAY_LINE_CAP
  const lines = content.split('\n')
  if (lines.length <= cap) return { text: content, hidden: 0 }
  return { text: lines.slice(0, cap).join('\n'), hidden: lines.length - cap }
}

export function OutputLine({
  content,
  verbose,
  isError = false,
  isWarning = false,
  linkifyUrls = false,
}: {
  content: string
  verbose: boolean
  isError?: boolean
  isWarning?: boolean
  linkifyUrls?: boolean
}): React.ReactNode {
  const expanded = useExpandShellOutput()
  const inVirtualList = useContext(InVirtualListContext)
  useTerminalSize()

  let text = tryJsonFormatContent(content.trim())
  if (linkifyUrls) text = linkifyUrlsInText(text)
  let hidden = 0
  if (!verbose && !expanded) {
    const truncated = truncateForDisplay(text, inVirtualList)
    text = truncated.text
    hidden = truncated.hidden
  }
  text = stripUnderlineAnsi(text)

  return (
    <MessageResponse>
      <Text color={isError ? 'error' : isWarning ? 'warning' : undefined}>
        <Ansi>{text}</Ansi>
        {hidden > 0 ? <Text dimColor>{`\n… +${hidden} lines`}</Text> : null}
      </Text>
    </MessageResponse>
  )
}
