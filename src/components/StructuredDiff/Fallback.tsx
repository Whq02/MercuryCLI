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
  originalCode: string
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
      originalCode: line,
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

type Cell = {
  text: string
  emphasized: boolean
}

function wordPartsOf(line: DiffLine, dim: boolean): DiffPart[] | null {
  if (!line.wordDiff || !line.matchedLine || dim) return null
  const parts: DiffPart[] =
    line.type === 'add'
      ? diffWordsWithSpace(line.matchedLine.code, line.code)
      : diffWordsWithSpace(line.code, line.matchedLine.code)
  return changedFraction(parts) <= WORD_DIFF_MAX_CHANGED_FRACTION ? parts : null
}

function wordRowsOf(
  line: DiffLine,
  parts: DiffPart[],
  contentWidth: number,
): Cell[][] {
  let current: Cell[] = []
  const rows: Cell[][] = [current]
  let column = 0
  for (const part of parts) {
    if (line.type === 'add' ? part.removed : part.added) continue
    const emphasized = Boolean(part.added || part.removed)
    wrapLines(part.value, contentWidth).forEach((piece, index) => {
      const pieceWidth = stringWidth(piece)
      if (index > 0 || column + pieceWidth > contentWidth) {
        current = []
        rows.push(current)
        column = 0
      }
      current.push({ text: piece, emphasized })
      column += pieceWidth
    })
  }
  return rows
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
  const targetWidth = Math.max(1, Math.floor(width))
  const numberedLines = numberDiffLines(
    processAdjacentLines(transformLinesToObjects(patch.lines)),
    patch.oldStart,
    patch.newStart,
  )
  const numberColumn =
    numberedLines.reduce(
      (max, line) => Math.max(max, String(line.lineNumber).length),
      1,
    ) + 1
  const contentWidth = Math.max(1, targetWidth - numberColumn - 2)
  const continuation = `${' '.repeat(numberColumn)} `
  const fill = (used: number): string =>
    ' '.repeat(Math.max(0, contentWidth - used))

  const rows: React.ReactNode[] = []
  numberedLines.forEach((line, lineIndex) => {
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
    const wordBg = isAdd ? theme.diffAddedWord : theme.diffRemovedWord
    const numberText = `${String(line.lineNumber).padStart(numberColumn - 1)} ${sigil}`
    const parts = wordPartsOf(line, dim)

    if (parts === null) {
      wrapLines(line.code === '' ? ' ' : line.code, contentWidth).forEach(
        (segment, rowIndex) => {
          rows.push(
            <Box key={`${lineIndex}-${rowIndex}`}>
              <NoSelect fromLeftEdge>
                <Text
                  backgroundColor={rowBg}
                  color={theme.text}
                  dimColor={line.type === 'nochange' || dim}
                >
                  {rowIndex === 0 ? numberText : continuation}
                </Text>
              </NoSelect>
              <Text backgroundColor={rowBg} color={theme.text} dimColor={dim}>
                {segment}
                {fill(stringWidth(segment))}
              </Text>
            </Box>,
          )
        },
      )
      return
    }

    wordRowsOf(line, parts, contentWidth).forEach((cells, rowIndex) => {
      rows.push(
        <Box key={`${lineIndex}-${rowIndex}`}>
          <NoSelect fromLeftEdge>
            <Text backgroundColor={rowBg} color={theme.text}>
              {rowIndex === 0 ? numberText : continuation}
            </Text>
          </NoSelect>
          <Text backgroundColor={rowBg} color={theme.text}>
            {cells.map((cell, cellIndex) => (
              <Text
                key={cellIndex}
                backgroundColor={cell.emphasized ? wordBg : rowBg}
                color={theme.text}
              >
                {cell.text}
              </Text>
            ))}
            {fill(cells.reduce((sum, cell) => sum + stringWidth(cell.text), 0))}
          </Text>
        </Box>,
      )
    })
  })

  return <Box flexDirection="column">{rows}</Box>
}
