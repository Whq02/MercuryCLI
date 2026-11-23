import React from 'react'
import { Box, Text } from '../../ink.js'
import { NoSelect } from '../../ink/components/NoSelect.js'
import type { StructuredPatchHunk } from '../../utils/diff.js'
import { useTheme } from '../design-system/ThemeProvider.js'
import { getTheme } from '../../utils/theme.js'
import wrapText from '../../ink/wrap-text.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { diffWordsWithSpace } from 'diff'

const wrapLines = (text: string, width: number): string[] =>
  wrapText(text, width, 'wrap').split('\n')

type LineObject = {
  code: string
  type: 'add' | 'remove' | 'nochange'
  wordDiff: boolean
  matchedLine?: LineObject
}

type DiffLine = LineObject & { lineNumber: number }

type DiffPart = {
  value: string
  added?: boolean
  removed?: boolean
}

function transformLinesToObjects(lines: string[]): LineObject[] {
  return lines.map(line => {
    const type: LineObject['type'] = line.startsWith('+')
      ? 'add'
      : line.startsWith('-')
        ? 'remove'
        : 'nochange'
    return {
      code: line.slice(1),
      type,
      wordDiff: false,
    }
  })
}

function processAdjacentLines(lines: LineObject[]): LineObject[] {
  const result: LineObject[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i]!.type !== 'remove') {
      result.push(lines[i]!)
      i += 1
      continue
    }
    const removals: LineObject[] = []
    while (i < lines.length && lines[i]!.type === 'remove') {
      removals.push(lines[i]!)
      i += 1
    }
    const additions: LineObject[] = []
    while (i < lines.length && lines[i]!.type === 'add') {
      additions.push(lines[i]!)
      i += 1
    }
    const paired = Math.min(removals.length, additions.length)
    for (let k = 0; k < paired; k++) {
      removals[k]!.wordDiff = true
      removals[k]!.matchedLine = additions[k]!
      additions[k]!.wordDiff = true
      additions[k]!.matchedLine = removals[k]!
    }
    result.push(...removals, ...additions)
  }
  return result
}

function numberDiffLines(
  lines: LineObject[],
  oldStart: number,
  newStart: number,
): DiffLine[] {
  let oldLine = oldStart
  let newLine = newStart
  return lines.map(line => {
    if (line.type === 'remove') return { ...line, lineNumber: oldLine++ }
    if (line.type === 'add') return { ...line, lineNumber: newLine++ }
    oldLine++
    return { ...line, lineNumber: newLine++ }
  })
}

const WORD_DIFF_MAX_CHANGED_FRACTION = 0.4

function changedFraction(parts: DiffPart[]): number {
  let changed = 0
  let total = 0
  for (const part of parts) {
    total += part.value.length
    if (part.added || part.removed) changed += part.value.length
  }
  const common = total - changed
  const denominator = common * 2 + changed
  if (denominator === 0) return 0
  return changed / denominator
}

type StyledSegment = {
  text: string
  emphasized: boolean
}

function appendSegment(
  row: StyledSegment[],
  text: string,
  emphasized: boolean,
): void {
  if (text === '') return
  const last = row[row.length - 1]
  if (last && last.emphasized === emphasized) {
    last.text += text
  } else {
    row.push({ text, emphasized })
  }
}

function wrapStyledSegments(
  segments: StyledSegment[],
  width: number,
): StyledSegment[][] {
  const rows: StyledSegment[][] = [[]]
  let col = 0

  const pushChars = (text: string, emphasized: boolean): void => {
    for (const ch of Array.from(text)) {
      const chWidth = stringWidth(ch)
      if (col > 0 && col + chWidth > width) {
        rows.push([])
        col = 0
      }
      appendSegment(rows[rows.length - 1]!, ch, emphasized)
      col += chWidth
    }
  }

  for (const segment of segments) {
    const tokens = segment.text.match(/\s+|[^\s]+/g)
    if (!tokens) continue
    for (const token of tokens) {
      const tokenWidth = stringWidth(token)
      if (col + tokenWidth <= width) {
        appendSegment(rows[rows.length - 1]!, token, segment.emphasized)
        col += tokenWidth
      } else if (/^\s+$/.test(token)) {
        pushChars(token, segment.emphasized)
      } else if (tokenWidth <= width) {
        rows.push([])
        col = 0
        appendSegment(rows[rows.length - 1]!, token, segment.emphasized)
        col = tokenWidth
      } else {
        pushChars(token, segment.emphasized)
      }
    }
  }

  return rows
}

function buildWordDiffRows(
  line: DiffLine,
  contentWidth: number,
): StyledSegment[][] | null {
  if (!line.wordDiff || !line.matchedLine) return null
  const parts: DiffPart[] =
    line.type === 'remove'
      ? diffWordsWithSpace(line.code, line.matchedLine.code)
      : diffWordsWithSpace(line.matchedLine.code, line.code)
  if (changedFraction(parts) > WORD_DIFF_MAX_CHANGED_FRACTION) return null
  const segments: StyledSegment[] = []
  for (const part of parts) {
    if (line.type === 'remove') {
      if (part.added) continue
      segments.push({ text: part.value, emphasized: Boolean(part.removed) })
    } else {
      if (part.removed) continue
      segments.push({ text: part.value, emphasized: Boolean(part.added) })
    }
  }
  return wrapStyledSegments(segments, contentWidth)
}

export function StructuredDiffFallback({
  patch,
  dim,
  width,
}: {
  patch: StructuredPatchHunk
  dim: boolean
  width: number
}): React.ReactNode {
  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  const numberedLines = numberDiffLines(
    processAdjacentLines(transformLinesToObjects(patch.lines)),
    patch.oldStart,
    patch.newStart,
  )
  const maxDigitWidth = numberedLines.reduce(
    (max, line) => Math.max(max, String(line.lineNumber).length),
    1,
  )
  const gutterWidth = maxDigitWidth + 1
  const targetWidth = Math.max(1, Math.floor(width))
  const contentWidth = Math.max(1, targetWidth - gutterWidth - 2)
  const continuationGutter = ' '.repeat(gutterWidth + 1)

  const rows: React.ReactNode[] = []
  for (let lineIndex = 0; lineIndex < numberedLines.length; lineIndex++) {
    const line = numberedLines[lineIndex]!
    const isAdd = line.type === 'add'
    const isRemove = line.type === 'remove'
    const sigil = isAdd ? '+' : isRemove ? '-' : ' '
    const rowBg = isAdd
      ? dim
        ? theme.diffAddedDimmed
        : theme.diffAdded
      : isRemove
        ? dim
          ? theme.diffRemovedDimmed
          : theme.diffRemoved
        : undefined
    const wordBg = isAdd
      ? theme.diffAddedWord
      : isRemove
        ? theme.diffRemovedWord
        : undefined

    const wrappedRows =
      (!dim ? buildWordDiffRows(line, contentWidth) : null) ??
      wrapLines(line.code, contentWidth).map(text => [
        { text, emphasized: false },
      ])

    for (let rowIndex = 0; rowIndex < wrappedRows.length; rowIndex++) {
      const row = wrappedRows[rowIndex]!
      const gutterText =
        rowIndex === 0
          ? `${String(line.lineNumber).padStart(maxDigitWidth, ' ')} ${sigil}`
          : continuationGutter
      const rowWidth = row.reduce(
        (sum, seg) => sum + stringWidth(seg.text),
        0,
      )
      const pad = Math.max(0, contentWidth - rowWidth)
      rows.push(
        <Box key={`${lineIndex}-${rowIndex}`} flexDirection="row">
          <NoSelect fromLeftEdge flexShrink={0}>
            <Text
              dimColor={line.type === 'nochange' || dim}
              backgroundColor={rowBg}
            >
              {gutterText}
            </Text>
          </NoSelect>
          <Text dimColor={dim} backgroundColor={rowBg}>
            {row.map((seg, segIndex) =>
              seg.emphasized ? (
                <Text key={segIndex} backgroundColor={wordBg}>
                  {seg.text}
                </Text>
              ) : (
                <React.Fragment key={segIndex}>{seg.text}</React.Fragment>
              ),
            )}
            {pad > 0 ? ' '.repeat(pad) : null}
          </Text>
        </Box>,
      )
    }
  }

  return <Box flexDirection="column">{rows}</Box>
}
