import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/prompt.js'
import { GREP_TOOL_NAME } from '../tools/GrepTool/prompt.js'
import { WEB_FETCH_TOOL_NAME } from '../tools/WebFetchTool/prompt.js'
import type { ContextData } from './analyzeContext.js'
import { getDisplayPath } from './file.js'
import { formatTokens } from './format.js'

/**
 * Turn a context-usage snapshot into ranked, human-readable advice items.
 * The snapshot shape is a cross-slice interface produced by analyzeContext.
 */

export type SuggestionSeverity = 'info' | 'warning'

export type ContextSuggestion = {
  severity: SuggestionSeverity
  title: string
  detail: string
  savingsTokens?: number
}

// Thresholds (contract data).
const LARGE_TOOL_RESULT_SHARE = 0.15
const LARGE_TOOL_RESULT_MIN_TOKENS = 10_000
const READ_BLOAT_SHARE = 0.05
const READ_BLOAT_MIN_TOKENS = 10_000
const NEAR_CAPACITY_PERCENT = 80
const MEMORY_BLOAT_SHARE = 0.05
const MEMORY_BLOAT_MIN_TOKENS = 5_000
const GENERIC_TOOL_SHARE = 0.2

export function generateContextSuggestions(data: ContextData): ContextSuggestion[] {
  const suggestions: ContextSuggestion[] = []
  const windowTokens = data.rawMaxTokens

  // Near capacity.
  if (data.percentage >= NEAR_CAPACITY_PERCENT) {
    suggestions.push({
      severity: 'warning',
      title: `Context is ${data.percentage}% full`,
      detail: data.isAutoCompactEnabled
        ? 'Auto-compaction will trigger soon and discard older messages. Run /compact now to control what is kept.'
        : 'Auto-compaction is disabled, so the conversation will hit the limit. Run /compact, or enable auto-compaction in /config.',
    })
  }

  // Large tool results, per tool.
  const largeToolNames = new Set<string>()
  const toolRows = data.messageBreakdown?.toolCallsByType ?? []
  for (const row of toolRows) {
    const totalForTool = row.callTokens + row.resultTokens
    const share = totalForTool / windowTokens
    if (share < LARGE_TOOL_RESULT_SHARE || totalForTool < LARGE_TOOL_RESULT_MIN_TOKENS) continue
    const percent = Math.round(share * 100)
    const title = `${row.name} is using ${formatTokens(totalForTool)} tokens (${percent}%)`
    if (row.name === BASH_TOOL_NAME) {
      largeToolNames.add(row.name)
      suggestions.push({
        severity: 'warning',
        title,
        detail:
          'Pipe command output through head/tail/grep and avoid dumping whole files; use the Read tool with offset and limit instead.',
        savingsTokens: Math.round(totalForTool * 0.5),
      })
    } else if (row.name === FILE_READ_TOOL_NAME) {
      largeToolNames.add(row.name)
      suggestions.push({
        severity: 'info',
        title,
        detail: 'Use offset and limit to read only the needed part of a file, and avoid re-reading whole files.',
        savingsTokens: Math.round(totalForTool * 0.3),
      })
    } else if (row.name === GREP_TOOL_NAME) {
      largeToolNames.add(row.name)
      suggestions.push({
        severity: 'info',
        title,
        detail:
          'Use more specific patterns and the glob/type narrowing parameters; for pure file discovery, prefer the Glob tool.',
        savingsTokens: Math.round(totalForTool * 0.3),
      })
    } else if (row.name === WEB_FETCH_TOOL_NAME) {
      largeToolNames.add(row.name)
      suggestions.push({
        severity: 'info',
        title,
        detail: 'Fetched page content can be very large; extract only what is needed from each page.',
        savingsTokens: Math.round(totalForTool * 0.4),
      })
    } else if (share >= GENERIC_TOOL_SHARE) {
      largeToolNames.add(row.name)
      suggestions.push({
        severity: 'info',
        title,
        detail: `${row.name} is consuming a significant share of the context window.`,
        savingsTokens: Math.round(totalForTool * 0.2),
      })
    }
  }

  // Read-result bloat — skipped when the read tool already qualified above.
  const readRow = toolRows.find(row => row.name === FILE_READ_TOOL_NAME)
  if (readRow && !largeToolNames.has(FILE_READ_TOOL_NAME)) {
    const resultShare = readRow.resultTokens / windowTokens
    if (resultShare >= READ_BLOAT_SHARE && readRow.resultTokens >= READ_BLOAT_MIN_TOKENS) {
      suggestions.push({
        severity: 'info',
        title: `File reads are using ${formatTokens(readRow.resultTokens)} tokens (${Math.round(resultShare * 100)}%)`,
        detail:
          'Reference earlier reads instead of re-reading files, and use offset and limit for large files.',
        savingsTokens: Math.round(readRow.resultTokens * 0.3),
      })
    }
  }

  // Memory bloat.
  const memoryTokens = data.memoryFiles.reduce((total, file) => total + file.tokens, 0)
  const memoryShare = memoryTokens / windowTokens
  if (memoryShare >= MEMORY_BLOAT_SHARE && memoryTokens >= MEMORY_BLOAT_MIN_TOKENS) {
    const largest = [...data.memoryFiles]
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 3)
      .map(file => `${getDisplayPath(file.path)} (${formatTokens(file.tokens)})`)
      .join(', ')
    suggestions.push({
      severity: 'info',
      title: `Memory files are using ${formatTokens(memoryTokens)} tokens (${Math.round(memoryShare * 100)}%)`,
      detail: `Largest: ${largest}. Review and prune them through /memory.`,
      savingsTokens: Math.round(memoryTokens * 0.3),
    })
  }

  // Auto-compaction disabled at moderate usage. No estimated saving, so it
  // sorts last among informational items.
  if (
    !data.isAutoCompactEnabled &&
    data.percentage >= 50 &&
    data.percentage < NEAR_CAPACITY_PERCENT
  ) {
    suggestions.push({
      severity: 'info',
      title: 'Auto-compaction is disabled',
      detail:
        'Without it the conversation will eventually hit the context limit and be lost. Enable it in /config, or run /compact manually.',
    })
  }

  // Warnings first; within a severity, descending estimated saving.
  return suggestions.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'warning' ? -1 : 1
    return (b.savingsTokens ?? 0) - (a.savingsTokens ?? 0)
  })
}
