import React from 'react'
import { Box, Text } from '../../ink.js'
import { NoSelect } from '../../ink/components/NoSelect.js'
import type { StructuredPatchHunk } from '../../utils/diff.js'
import { useTheme } from '../design-system/ThemeProvider.js'
import { getTheme } from '../../utils/theme.js'
import wrapText from '../../ink/wrap-text.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

const wrapLines = (text: string, width: number): string[] =>
  wrapText(text, width, 'wrap').split('\n')

type LineObject = Unbuilt

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
      originalCode: line,
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

export function StructuredDiffFallback(arg0: {
  patch: StructuredPatchHunk
  dim: boolean
  width: number
}): React.ReactNode {
  return notBuilt('src/components/StructuredDiff/Fallback.tsx:170')
}
