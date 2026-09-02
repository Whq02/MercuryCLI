/**
 * The interview preview frame (MERCURY INTERVIEW Wave B, reimplemented at
 * the owner) — a bordered monospace box for one option's rendered preview.
 *
 * Width truth is display cells (stringWidth / sliceAnsi), never string
 * length; markdown renders WIDTH-AWARE so tables budget their columns to
 * the frame instead of being silently right-chopped; the render memoizes on
 * every material input so focus movement between options never re-renders
 * an unchanged preview (the D1 preview-cost law). Truncation is explicit:
 * a labeled bar names exactly how many lines are hidden.
 */
import React, { Suspense, use, useMemo } from 'react'
import { useSettings } from '../../../hooks/useSettings.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { stringWidth } from '../../../ink/stringWidth.js'
import { Ansi, Box, Text, useTheme } from '../../../ink.js'
import { type CliHighlight, getCliHighlightPromise } from '../../../utils/cliHighlight.js'
import { applyMarkdown } from '../../../utils/markdown.js'
import sliceAnsi from '../../../utils/sliceAnsi.js'

type PreviewBoxProps = {
  /** The preview content. Markdown renders with syntax highlighting for
   *  code fences; plain multi-line text passes through. */
  content: string
  /** Maximum content lines before the truncation bar. @default 20 */
  maxLines?: number
  /** Minimum height (lines); shorter content pads to it. */
  minHeight?: number
  /** Minimum frame width. @default 40 */
  minWidth?: number
  /** Maximum frame width (the container's budget). */
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
  // Floor the frame geometry so a very narrow terminal degrades to a tiny
  // box instead of driving the border repeats below negative (RangeError).
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
  // U+22EF midline ellipsis — width-1 and non-emoji on every terminal
  //
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
