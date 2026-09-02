// /context — the provider-generic static print (telemetry-truth lane):
// brand row · one meter line (model + window + used%) · the density grid
// beside the breakdown · compact detail sections (top-N + a pointer line,
// never an unbounded dump) · suggestions. Truth rules: the window derives
// at render from the model-catalogue owner (already inside `data`), the
// usage TOTAL prefers the transcript's own recorded API usage — the one
// size every provider states itself — and absent facts render as quiet
// honest absence (an unmeasured source says so; a logged-out session names
// the attach route). This surface must render for ALL 8 provider families:
// nothing here may reach a provider-specific singleton, and the only hook
// user in the tree (the Wordmark's shimmer) reads settings provider-safe,
// so the detached renderToAnsiString root can never throw the print away
//

import React from 'react'
import { Box, Text } from '../ink.js'
import type { ContextData } from '../utils/analyzeContext.js'
import type { RequestContextPlan } from '../services/run/requestContextPlan.js'
import { activeSourceUsage } from '../services/providers/providerUsage.js'
import { generateContextSuggestions } from '../utils/contextSuggestions.js'
import { formatNumber } from '../utils/format.js'
import { Wordmark } from './mercury-ui/assets.js'
import { ContextSuggestions } from './ContextSuggestions.js'

/** The reserve/free category names assigned upstream (analyzeContext keeps
 *  them private — mirrored here, census-noted). */
const FREE_SPACE_NAME = 'Free space'
const RESERVE_NAMES = new Set(['Autocompact buffer', 'Compact buffer'])

/** Per-section row cap: the print stays a summary; the owning board holds
 *  the full list (the pointer line names it). */
const SECTION_ROWS = 8

function meterGlyph(square: {
  categoryName: string
  squareFullness: number
}): string {
  if (square.categoryName === FREE_SPACE_NAME) return '·'
  if (RESERVE_NAMES.has(square.categoryName)) return '▒'
  return square.squareFullness >= 0.7 ? '█' : '▓'
}

/** Percentage gauge tone. */
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

/** One compact detail section: header + top rows + an honest `+N more`
 *  pointer to the owning board. Empty sections render nothing. */
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

export function ContextVisualization({
  data,
  plan,
}: {
  data: ContextData
  plan?: RequestContextPlan
}): React.ReactNode {
  const visible = data.categories.filter(
    category =>
      category.name !== FREE_SPACE_NAME &&
      !RESERVE_NAMES.has(category.name) &&
      !category.isDeferred &&
      category.tokens > 0,
  )
  const freeSpace = data.categories.find(c => c.name === FREE_SPACE_NAME)
  const reserved = data.categories.filter(c => RESERVE_NAMES.has(c.name))
  const suggestions = generateContextSuggestions(data)
  // The active-source fact (pure sync read — safe in the detached root):
  // logged-out gets the attach route instead of unexplained zeros.
  const source = activeSourceUsage()

  const loadedMcp = data.mcpTools.filter(tool => tool.isLoaded !== false)
  const deferredMcp = data.mcpTools.filter(tool => tool.isLoaded === false)

  return (
    <Box flexDirection="column">
      <Box>
        <Wordmark />
        <Text dimColor> — context</Text>
      </Box>

      {/* ONE meter line: model · used/window (pct). The window number in
          `data` derives from the live model-catalogue resolver. */}
      <Box marginTop={1}>
        <Text>
          <Text bold>{data.model}</Text>
          <Text dimColor>
            {' '}
            {formatNumber(data.totalTokens)}/{formatNumber(data.maxTokens)} tokens{' '}
          </Text>
          <Text color={gaugeColor(data.percentage)}>
            ({Math.round(data.percentage)}%)
          </Text>
        </Text>
      </Box>
      {plan ? (
        <Box flexDirection="column">
          <Text dimColor>
            plan {plan.digest.slice(0, 12)} · epoch {plan.epoch} ·{' '}
            {plan.mode === 'apply'
              ? 'what was sent'
              : 'what the next request would send'}
          </Text>
          {plan.reductions.reasons.map((reason, index) => (
            <Text key={index} dimColor>
              {'  '}− {reason}
            </Text>
          ))}
          {plan.unknownFields.map((field, index) => (
            <Text key={index} dimColor>
              {'  '}? {field}
            </Text>
          ))}
        </Box>
      ) : null}

      {/* Honest-absence lines — quiet, never a blank block (law 1). */}
      {source.sourceKind === 'none' ? (
        <Text dimColor>not logged in — /logins connects</Text>
      ) : null}
      {!data.countsAvailable ? (
        <Text dimColor>
          category sizes not measured on this source — the total, the grid and free space follow the recorded usage
        </Text>
      ) : null}

      <Box gap={2} marginTop={1}>
        <Box flexDirection="column">
          {data.gridRows.map((row, rowIndex) => (
            <Text key={rowIndex}>
              {row.map((square, columnIndex) => (
                <Text key={columnIndex} color={square.color}>
                  {meterGlyph(square)}
                </Text>
              ))}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text bold>Breakdown</Text>
          {visible.map(category => (
            <Text key={category.name}>
              <Text color={category.color}>■ </Text>
              {category.name}
              <Text dimColor>
                {' '}
                {formatNumber(category.tokens)} (
                {((category.tokens / data.maxTokens) * 100).toFixed(1)}%)
              </Text>
            </Text>
          ))}
          {visible.length === 0 ? (
            <Text dimColor>
              {data.countsAvailable ? 'nothing measured yet' : 'unmeasured'}
            </Text>
          ) : null}
          {freeSpace && freeSpace.tokens > 0 ? (
            <Text>
              <Text dimColor>· </Text>
              {FREE_SPACE_NAME}
              <Text dimColor> {formatNumber(freeSpace.tokens)}</Text>
            </Text>
          ) : null}
          {reserved.map(category =>
            category.tokens > 0 ? (
              <Text key={category.name}>
                <Text dimColor>▒ </Text>
                {category.name}
                <Text dimColor> {formatNumber(category.tokens)}</Text>
              </Text>
            ) : null,
          )}
        </Box>
      </Box>

      <DetailSection
        title="MCP tools"
        board="/mcp"
        extraHeader={
          deferredMcp.length > 0 ? (
            <Text dimColor> ({deferredMcp.length} load on demand)</Text>
          ) : undefined
        }
        rows={[...loadedMcp]
          .sort((a, b) => b.tokens - a.tokens)
          .map(tool => ({
            key: `${tool.serverName}:${tool.name}`,
            label: `${tool.serverName} · ${tool.name}`,
            tokens: tool.tokens,
          }))}
      />
      <DetailSection
        title="Custom agents"
        board="/agents"
        rows={bySourceThenTokens(
          data.agents.map(agent => ({ ...agent, source: String(agent.source) })),
        ).map(agent => ({
          key: agent.agentType,
          label: `${agent.agentType} (${agent.source})`,
          tokens: agent.tokens,
        }))}
      />
      <DetailSection
        title="Memory files"
        board="/memory"
        rows={data.memoryFiles.map(file => ({
          key: file.path,
          label: file.path,
          tokens: file.tokens,
        }))}
      />
      <DetailSection
        title="Skills"
        board="/skills"
        rows={
          data.skills
            ? bySourceThenTokens(
                data.skills.skillFrontmatter.map(skill => ({
                  ...skill,
                  source: String(skill.source),
                })),
              ).map(skill => ({
                key: skill.name,
                label: `${skill.name} (${skill.source})`,
                tokens: skill.tokens,
              }))
            : []
        }
      />
      {data.skills?.listingTruncation &&
      (data.skills.listingTruncation.nameOnly > 0 || data.skills.listingTruncation.withheld > 0) ? (
        <Box marginLeft={2}>
          <Text dimColor wrap="truncate-end">
            skill listing degraded by its budget: {data.skills.listingTruncation.nameOnly} entr
            {data.skills.listingTruncation.nameOnly === 1 ? 'y' : 'ies'} name-only
            {data.skills.listingTruncation.withheld > 0
              ? ` · ${data.skills.listingTruncation.withheld} name(s) withheld`
              : ''}
          </Text>
        </Box>
      ) : null}

      <ContextSuggestions suggestions={suggestions} />
    </Box>
  )
}

export default ContextVisualization
