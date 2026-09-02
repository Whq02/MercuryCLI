
import React from 'react'
import { Box, Text } from '../../ink.js'
import { NoSelect } from '../../ink/components/NoSelect.js'
import type { StructuredPatchHunk } from '../../utils/diff.js'
import { useTheme } from '../design-system/ThemeProvider.js'
import { getTheme } from '../../utils/theme.js'
import wrapText from '../../ink/wrap-text.js'
import { stringWidth } from '../../ink/stringWidth.js'

const wrapLines = (text: string, width: number): string[] =>
  wrapText(text, width, 'wrap').split('\n')

export type LineObject = {
  code: string
  type: 'add' | 'remove' | 'nochange'
  originalCode: string
  wordDiff: boolean
  matchedLine?: LineObject
}

export type DiffLine = LineObject & { lineNumber: number }

export type DiffPart = {
  value: string
  added?: boolean
  removed?: boolean
}

export function transformLinesToObjects(lines: string[]): LineObject[] {
  return lines.map(line => {
    const type: LineObject['type'] = line.startsWith('+')
      ? 'add'
      : line.startsWith('-')
        ? 'remove'
        : 'nochange'
    return {
      code: line.slice(1),
      type,
      originalCode: line,
      wordDiff: false,
    }
  })
}

export function processAdjacentLines(lines: LineObject[]): LineObject[] {
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

export function calculateWordDiffs(
  oldText: string,
  newText: string,
): DiffPart[] {
  const tokenize = (text: string): string[] =>
    text.match(/\s+|[^\s]+/g) ?? []
  const oldTokens = tokenize(oldText)
  const newTokens = tokenize(newText)
  const m = oldTokens.length
  const n = newTokens.length
  const table: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  )
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      table[i]![j] =
        oldTokens[i] === newTokens[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }
  const parts: DiffPart[] = []
  const push = (value: string, kind: 'common' | 'added' | 'removed'): void => {
    const last = parts[parts.length - 1]
    const flags = {
      added: kind === 'added' ? true : undefined,
      removed: kind === 'removed' ? true : undefined,
    }
    if (
      last &&
      Boolean(last.added) === Boolean(flags.added) &&
      Boolean(last.removed) === Boolean(flags.removed)
    ) {
      last.value += value
    } else {
      parts.push({ value, ...flags })
    }
  }
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (oldTokens[i] === newTokens[j]) {
      push(oldTokens[i]!, 'common')
      i += 1
      j += 1
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      push(oldTokens[i]!, 'removed')
      i += 1
    } else {
      push(newTokens[j]!, 'added')
      j += 1
    }
  }
  while (i < m) {
    push(oldTokens[i]!, 'removed')
    i += 1
  }
  while (j < n) {
    push(newTokens[j]!, 'added')
    j += 1
  }
  return parts
}

export function numberDiffLines(
  lines: LineObject[],
  startLine: number,
): DiffLine[] {
  const result: DiffLine[] = []
  let counter = startLine
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.type === 'remove') {
      const runStart = counter
      let runLength = 0
      while (i < lines.length && lines[i]!.type === 'remove') {
        result.push({ ...lines[i]!, lineNumber: runStart + runLength })
        runLength += 1
        i += 1
      }
      counter = runStart
      continue
    }
    result.push({ ...line, lineNumber: counter })
    counter += 1
    i += 1
  }
  return result
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

  const numbered = numberDiffLines(
    processAdjacentLines(transformLinesToObjects(patch.lines)),
    patch.oldStart,
  )

  const numberColumn =
    Math.max(1, ...numbered.map(line => String(line.lineNumber).length)) + 1
  const contentWidth = Math.max(1, targetWidth - numberColumn - 1 - 1)

  const rowBackground = (line: DiffLine): string | undefined => {
    if (line.type === 'add') return dim ? theme.diffAddedDimmed : theme.diffAdded
    if (line.type === 'remove') {
      return dim ? theme.diffRemovedDimmed : theme.diffRemoved
    }
    return undefined
  }
  const wordBackground = (line: DiffLine): string =>
    line.type === 'add' ? theme.diffAddedWord : theme.diffRemovedWord

  const sigilOf = (line: DiffLine): string =>
    line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '

  const renderRow = (
    line: DiffLine,
    key: number,
  ): React.ReactNode => {
    const background = rowBackground(line)
    const sigil = sigilOf(line)
    const numberText = `${String(line.lineNumber).padStart(numberColumn - 1)} `
    const continuationPad = ' '.repeat(numberColumn)

    let parts: DiffPart[] | null = null
    if (line.wordDiff && line.matchedLine && !dim) {
      const computed =
        line.type === 'add'
          ? calculateWordDiffs(line.matchedLine.code, line.code)
          : calculateWordDiffs(line.code, line.matchedLine.code)
      if (changedFraction(computed) <= WORD_DIFF_MAX_CHANGED_FRACTION) {
        parts = computed
      }
    }

    if (parts === null) {
      const wrapped = wrapLines(line.code === '' ? ' ' : line.code, contentWidth)
      return wrapped.map((segment, index) => (
        <Box key={`${key}:${index}`}>
          <NoSelect fromLeftEdge>
            <Text
              backgroundColor={background}
              color={theme.text}
              dimColor={line.type === 'nochange' ? true : dim}
            >
              {index === 0 ? numberText : continuationPad}
              {index === 0 ? sigil : ' '}
            </Text>
          </NoSelect>
          <Text backgroundColor={background} color={theme.text} dimColor={dim}>
            {
}
            {segment + ' '.repeat(Math.max(0, contentWidth - stringWidth(segment)))}
          </Text>
        </Box>
      ))
    }

    const visible = parts.filter(part =>
      line.type === 'add' ? !part.removed : !part.added,
    )
    type Cell = { text: string; emphasised: boolean }
    const rendered: Cell[][] = [[]]
    let column = 0
    for (const part of visible) {
      const emphasised = Boolean(part.added || part.removed)
      const pieces = wrapLines(part.value, contentWidth)
      pieces.forEach((piece, pieceIndex) => {
        if (pieceIndex > 0 || column + stringWidth(piece) > contentWidth) {
          rendered.push([])
          column = 0
        }
        rendered[rendered.length - 1]!.push({ text: piece, emphasised })
        column += stringWidth(piece)
      })
    }
    return rendered.map((cells, index) => {
      const lineLength = cells.reduce((sum, cell) => sum + stringWidth(cell.text), 0)
      return (
        <Box key={`${key}:${index}`}>
          <NoSelect fromLeftEdge>
            <Text backgroundColor={background} color={theme.text}>
              {index === 0 ? numberText : continuationPad}
              {index === 0 ? sigil : ' '}
            </Text>
          </NoSelect>
          <Text backgroundColor={background} color={theme.text}>
            {cells.map((cell, cellIndex) => (
              <Text
                key={cellIndex}
                backgroundColor={cell.emphasised ? wordBackground(line) : background}
                color={theme.text}
              >
                {cell.text}
              </Text>
            ))}
            {' '.repeat(Math.max(0, contentWidth - lineLength))}
          </Text>
        </Box>
      )
    })
  }

  return (
    <Box flexDirection="column">
      {numbered.map((line, index) => renderRow(line, index))}
    </Box>
  )
}
