import React, { useContext } from 'react'
import { Ansi, Text } from '../../ink.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { MessageResponse } from '../MessageResponse.js'
import { InVirtualListContext } from '../messageActions.js'
import { useExpandShellOutput } from './ExpandShellOutputContext.js'

const JSON_PASS_MAX_CHARS = 10_000

function tryFormatJson(line: string): string {
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

function tryJsonFormatContent(content: string): string {
  if (content.length > JSON_PASS_MAX_CHARS) return content
  return content
    .split('\n')
    .map(line => tryFormatJson(line))
    .join('\n')
}

function linkifyUrlsInText(content: string): string {
  return content.replace(
    /https?:\/\/[^\s"'<>\\]+/g,
    url => `\u001b]8;;${url}\u0007${url}\u001b]8;;\u0007`,
  )
}

function stripUnderlineAnsi(content: string): string {
  return content
    .replace(/\u001b\[4;/g, '\u001b[')
    .replace(/\u001b\[([0-9;]*);4m/g, '\u001b[$1m')
    .replace(/\u001b\[4m/g, '')
}

const DISPLAY_LINE_CAP = 10
const VIRTUAL_LIST_LINE_CAP = 25

const TRUNCATION_MARKER = /\[(\d+) bytes truncated from the middle — the head and the tail of the output are shown; the complete output is saved at ([^\]]+)\]/

function truncateForDisplay(
  content: string,
  inVirtualList: boolean,
): { text: string; hidden: number } {
  const cap = inVirtualList ? VIRTUAL_LIST_LINE_CAP : DISPLAY_LINE_CAP
  const lines = content.split('\n')
  if (lines.length <= cap) return { text: content, hidden: 0 }
  return { text: lines.slice(0, cap).join('\n'), hidden: lines.length - cap }
}

function foldKeepingMarker(
  content: string,
  inVirtualList: boolean,
): { text: string; hidden: number } {
  const marker = TRUNCATION_MARKER.exec(content)
  if (marker === null) return truncateForDisplay(content, inVirtualList)
  const markerLine = marker[0]
  const withoutMarker = content.replace(markerLine, '')
  const shown = truncateForDisplay(withoutMarker, inVirtualList)
  const shownText = shown.text.replace(/\s+$/, '')
  const markerShown = shownText.includes(markerLine)
  return {
    text: markerShown ? shownText : `${shownText}\n${markerLine}`,
    hidden: Math.max(0, shown.hidden - (markerShown ? 0 : 1)),
  }
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
    const truncated = foldKeepingMarker(text, inVirtualList)
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
