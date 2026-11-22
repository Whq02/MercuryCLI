import React from 'react'
import { Box, Text } from '../ink.js'
import type { ContextData } from '../services/context/analyzeContext.js'
import type { RequestContextPlan } from '../services/run/requestContextPlan.js'
import { activeSourceUsage } from '../services/providers/providerUsage.js'
import { generateContextSuggestions } from '../services/context/contextSuggestions.js'
import { formatNumber } from '../utils/format.js'
import { Wordmark } from './mercury-ui/assets.js'
import { ContextSuggestions } from './ContextSuggestions.js'
import { notBuilt } from '../pi/holes.js'

const FREE_SPACE_NAME = 'Free space'
const RESERVE_NAMES = new Set(['Autocompact buffer', 'Compact buffer'])

const SECTION_ROWS = 8

function meterGlyph(square: {
  categoryName: string
  squareFullness: number
}): string {
  if (square.categoryName === FREE_SPACE_NAME) return '·'
  if (RESERVE_NAMES.has(square.categoryName)) return '▒'
  return square.squareFullness >= 0.7 ? '█' : '▓'
}

function gaugeColor(percentage: number): string {
  if (percentage >= 90) return 'error'
  if (percentage >= 70) return 'warning'
  return 'success'
}

const SOURCE_ORDER = ['project', 'user', 'managed', 'extension', 'built-in']

function bySourceThenTokens<T extends { source: string; tokens: number }>(
  rows: T[],
): T[] {
  return [...rows].sort((a, b) => {
    const sa = SOURCE_ORDER.indexOf(a.source)
    const sb = SOURCE_ORDER.indexOf(b.source)
    if (sa !== sb) return (sa === -1 ? 99 : sa) - (sb === -1 ? 99 : sb)
    return b.tokens - a.tokens
  })
}

function DetailSection({
  title,
  board,
  rows,
  extraHeader,
}: {
  title: string
  board: string
  rows: Array<{ key: string; label: string; tokens?: number; note?: string }>
  extraHeader?: React.ReactNode
}): React.ReactNode {
  if (rows.length === 0) return null
  const shown = rows.slice(0, SECTION_ROWS)
  const hidden = rows.length - shown.length
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>
        {title} <Text dimColor>· {board}</Text>
        {extraHeader}
      </Text>
      {shown.map(row => (
        <Text key={row.key} dimColor>
          {'  '}
          {row.label}
          {row.tokens !== undefined ? ` · ${formatNumber(row.tokens)}` : ''}
          {row.note ? ` ${row.note}` : ''}
        </Text>
      ))}
      {hidden > 0 ? (
        <Text dimColor>
          {'  '}+{hidden} more · {board}
        </Text>
      ) : null}
    </Box>
  )
}

export function ContextVisualization(arg0: {
  data: ContextData
  plan?: RequestContextPlan
}): React.ReactNode {
  return notBuilt('src/components/ContextVisualization.tsx:82')
}

export default ContextVisualization
