import React, { Suspense, use, useMemo } from 'react'
import { useSettings } from '../../../hooks/useSettings.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { stringWidth } from '../../../ink/stringWidth.js'
import { Ansi, Box, Text, useTheme } from '../../../ink.js'
import { type CliHighlight, getCliHighlightPromise } from '../../../utils/cliHighlight.js'
import { applyMarkdown } from '../../../utils/markdown.js'
import sliceAnsi from '../../../utils/sliceAnsi.js'

const FRAME = {
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  horizontal: '─',
  vertical: '│',
  teeLeft: '├',
  teeRight: '┤',
} as const

type PreviewBoxProps = {
  content: string
  minHeight?: number
  minWidth?: number
  maxWidth?: number
  maxLines?: number
}

export function PreviewBox(props: PreviewBoxProps): React.ReactNode {
  const settings = useSettings()
  if (settings.view?.syntaxOff) {
    return <PreviewBoxBody {...props} highlight={null} />
  }
  return (
    <Suspense fallback={<PreviewBoxBody {...props} highlight={null} />}>
      <PreviewBoxWithHighlight {...props} />
    </Suspense>
  )
}

function PreviewBoxWithHighlight(props: PreviewBoxProps): React.ReactNode {
  const highlight = use(getCliHighlightPromise()) as CliHighlight | null
  return <PreviewBoxBody {...props} highlight={highlight} />
}

function PreviewBoxBody({
  content,
  minHeight = 0,
  minWidth = 40,
  maxWidth,
  maxLines = 20,
  highlight,
}: PreviewBoxProps & { highlight: CliHighlight | null }): React.ReactNode {
  const { columns: terminalWidth } = useTerminalSize()
  const [theme] = useTheme()
  const effectiveMaxWidth = Math.max(8, maxWidth ?? terminalWidth - 4)

  const formatted = useMemo(
    () => applyMarkdown(content, theme, highlight, effectiveMaxWidth - 4),
    [content, theme, highlight, effectiveMaxWidth],
  )

  const allLines = formatted.split('\n')
  const truncated = allLines.length > maxLines
  const effectiveMaxLines = truncated ? Math.max(1, maxLines - 1) : maxLines
  const shownLines = truncated ? allLines.slice(0, effectiveMaxLines) : allLines
  const hiddenCount = allLines.length - shownLines.length

  const cappedMinHeight = Math.min(minHeight, maxLines)
  const usedHeight = shownLines.length + (truncated ? 1 : 0)
  const padLines = Math.max(0, cappedMinHeight - usedHeight)
  const paddedLines =
    padLines > 0
      ? [...shownLines, ...Array.from({ length: padLines }, () => '')]
      : shownLines

  let widestLine = 0
  for (const line of paddedLines) {
    widestLine = Math.max(widestLine, stringWidth(line))
  }
  const boxWidth = Math.min(effectiveMaxWidth, 4 + Math.max(minWidth, widestLine))
  const innerWidth = Math.max(0, boxWidth - 2)
  const contentWidth = Math.max(0, boxWidth - 4)

  const topBorder = `${FRAME.topLeft}${FRAME.horizontal.repeat(innerWidth)}${FRAME.topRight}`
  const bottomBorder = `${FRAME.bottomLeft}${FRAME.horizontal.repeat(innerWidth)}${FRAME.bottomRight}`

  let hiddenBar: string | null = null
  if (hiddenCount > 0) {
    const prefix = `${FRAME.horizontal.repeat(3)} ⋯ ${FRAME.horizontal.repeat(3)} ${hiddenCount} lines hidden `
    const prefixWidth = stringWidth(prefix)
    if (prefixWidth <= innerWidth) {
      hiddenBar = `${FRAME.teeLeft}${prefix}${FRAME.horizontal.repeat(innerWidth - prefixWidth)}${FRAME.teeRight}`
    } else {
      const clippedLabel = sliceAnsi(prefix, 0, innerWidth)
      const rem = Math.max(0, innerWidth - stringWidth(clippedLabel))
      hiddenBar = `${FRAME.teeLeft}${clippedLabel}${FRAME.horizontal.repeat(rem)}${FRAME.teeRight}`
    }
  }

  return (
    <Box flexDirection="column">
      <Text dimColor>{topBorder}</Text>
      {paddedLines.map((line, index) => {
        const clipped =
          stringWidth(line) > contentWidth ? sliceAnsi(line, 0, contentWidth) : line
        const rightPad = Math.max(0, contentWidth - stringWidth(clipped))
        return (
          <Text key={index}>
            <Text dimColor>{`${FRAME.vertical} `}</Text>
            <Ansi>{clipped}</Ansi>
            {' '.repeat(rightPad)}
            <Text dimColor>{` ${FRAME.vertical}`}</Text>
          </Text>
        )
      })}
      {hiddenBar !== null ? <Text color="warning">{hiddenBar}</Text> : null}
      <Text dimColor>{bottomBorder}</Text>
    </Box>
  )
}
