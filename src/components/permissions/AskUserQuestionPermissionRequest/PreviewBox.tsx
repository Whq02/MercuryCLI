import React, { Suspense, use, useMemo } from 'react'
import { useSettings } from '../../../hooks/useSettings.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { stringWidth } from '../../../ink/stringWidth.js'
import { Ansi, Box, Text, useTheme } from '../../../ink.js'
import { type CliHighlight, getCliHighlightPromise } from '../../../utils/cliHighlight.js'
import { applyMarkdown } from '../../../utils/markdown.js'
import sliceAnsi from '../../../utils/sliceAnsi.js'

type PreviewBoxProps = {
  content: string
  maxLines?: number
  minHeight?: number
  minWidth?: number
  maxWidth?: number
}

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

export function PreviewBox(props: PreviewBoxProps): React.ReactNode {
  const settings = useSettings()
  if (settings.syntaxHighlightingDisabled) {
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
  maxLines,
  minHeight,
  minWidth = 40,
  maxWidth,
  highlight,
}: PreviewBoxProps & { highlight: CliHighlight | null }): React.ReactNode {
  const { columns: terminalWidth } = useTerminalSize()
  const [theme] = useTheme()
  const effectiveMaxWidth = Math.max(8, maxWidth ?? terminalWidth - 4)
  const effectiveMaxLines = maxLines ?? 20

  const rendered = useMemo(
    () => applyMarkdown(content, theme, highlight, effectiveMaxWidth - 4),
    [content, theme, highlight, effectiveMaxWidth],
  )

  const contentLines = rendered.split('\n')
  const isTruncated = contentLines.length > effectiveMaxLines
  const shown = isTruncated ? contentLines.slice(0, effectiveMaxLines) : contentLines
  const effectiveMinHeight = Math.min(minHeight ?? 0, effectiveMaxLines)
  const padding = Math.max(0, effectiveMinHeight - shown.length - (isTruncated ? 1 : 0))
  const lines = padding > 0 ? [...shown, ...Array<string>(padding).fill('')] : shown

  const contentWidth = Math.max(minWidth, ...lines.map(l => stringWidth(l)))
  const boxWidth = Math.min(contentWidth + 4, effectiveMaxWidth)
  const innerWidth = boxWidth - 4

  const horizontal = FRAME.horizontal.repeat(boxWidth - 2)
  const truncationBar = isTruncated
    ? (() => {
        const hidden = contentLines.length - effectiveMaxLines
        const label = `${FRAME.horizontal.repeat(3)} ⋯ ${FRAME.horizontal.repeat(3)} ${hidden} lines hidden `
        const fill = Math.max(0, boxWidth - 2 - stringWidth(label))
        return `${FRAME.teeLeft}${label}${FRAME.horizontal.repeat(fill)}${FRAME.teeRight}`
      })()
    : null

  return (
    <Box flexDirection="column">
      <Text dimColor>{`${FRAME.topLeft}${horizontal}${FRAME.topRight}`}</Text>
      {lines.map((line, index) => {
        const clipped = stringWidth(line) > innerWidth ? sliceAnsi(line, 0, innerWidth) : line
        const pad = ' '.repeat(Math.max(0, innerWidth - stringWidth(clipped)))
        return (
          <Box key={index} flexDirection="row">
            <Text dimColor>{FRAME.vertical} </Text>
            <Ansi>{clipped}</Ansi>
            <Text dimColor>
              {pad} {FRAME.vertical}
            </Text>
          </Box>
        )
      })}
      {truncationBar && <Text color="warning">{truncationBar}</Text>}
      <Text dimColor>{`${FRAME.bottomLeft}${horizontal}${FRAME.bottomRight}`}</Text>
    </Box>
  )
}
