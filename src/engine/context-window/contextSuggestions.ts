import type { ContextData } from './analyzeContext.js'
import { getDisplayPath } from '../../platform/files/file.js'
import { formatTokens } from '../../platform/text/format.js'

export type ContextSuggestion = {
  severity: 'warning' | 'info'
  title: string
  detail: string
  savingsTokens?: number
}

const TOOL_MIN_TOKENS = 10_000
const TOOL_MIN_SHARE = 0.15
const OTHER_TOOL_MIN_SHARE = 0.2
const READ_NARROW_MIN_SHARE = 0.05
const INSTRUCTION_FILES_MIN_TOKENS = 5_000
const INSTRUCTION_FILES_MIN_SHARE = 0.05

export function generateContextSuggestions(data: ContextData): ContextSuggestion[] {
  const suggestions: ContextSuggestion[] = []
  const windowTokens = data.rawMaxTokens

  if (data.percentage >= 80) {
    suggestions.push({
      severity: 'warning',
      title: `Context is ${data.percentage}% full`,
      detail: data.isAutoCompactEnabled
        ? 'Auto-compaction will trigger soon and discard older messages. Run /compact now to control what is kept.'
        : 'Auto-compaction is disabled, so the conversation will hit the limit. Run /compact, or enable auto-compaction in /config.',
    })
  } else if (!data.isAutoCompactEnabled && data.percentage >= 50) {
    suggestions.push({
      severity: 'info',
      title: 'Auto-compaction is disabled',
      detail: 'Without it the conversation will eventually hit the context limit and be lost. Enable it in /config, or run /compact manually.',
    })
  }

  if (windowTokens > 0 && data.messageBreakdown) {
    let reportedRead = false
    for (const entry of data.messageBreakdown.toolCallsByType) {
      const total = entry.callTokens + entry.resultTokens
      const share = total / windowTokens
      if (total < TOOL_MIN_TOKENS || share < TOOL_MIN_SHARE) continue
      const pct = Math.round(share * 100)
      const formatted = formatTokens(total)
      const title = `${entry.name} is using ${formatted} tokens (${pct}%)`
      if (entry.name === 'Bash') {
        suggestions.push({
          severity: 'warning',
          title,
          detail: 'Pipe command output through head/tail/grep and avoid dumping whole files; use the Read tool with offset and limit instead.',
          savingsTokens: Math.round(total * 0.5),
        })
      } else if (entry.name === 'Read') {
        reportedRead = true
        suggestions.push({
          severity: 'info',
          title,
          detail: 'Use offset and limit to read only the needed part of a file, and avoid re-reading whole files.',
          savingsTokens: Math.round(total * 0.3),
        })
      } else if (entry.name === 'Grep') {
        suggestions.push({
          severity: 'info',
          title,
          detail: 'Use more specific patterns and the glob/type narrowing parameters; for pure file discovery, prefer the Glob tool.',
          savingsTokens: Math.round(total * 0.3),
        })
      } else if (entry.name === 'WebFetch') {
        suggestions.push({
          severity: 'info',
          title,
          detail: 'Fetched page content can be very large; extract only what is needed from each page.',
          savingsTokens: Math.round(total * 0.4),
        })
      } else if (share >= OTHER_TOOL_MIN_SHARE) {
        suggestions.push({
          severity: 'info',
          title,
          detail: `${entry.name} is consuming a significant share of the context window.`,
          savingsTokens: Math.round(total * 0.2),
        })
      }
    }

    if (!reportedRead) {
      const readEntry = data.messageBreakdown.toolCallsByType.find(entry => entry.name === 'Read')
      if (
        readEntry &&
        readEntry.resultTokens >= TOOL_MIN_TOKENS &&
        readEntry.resultTokens / windowTokens >= READ_NARROW_MIN_SHARE
      ) {
        const pct = Math.round((readEntry.resultTokens / windowTokens) * 100)
        suggestions.push({
          severity: 'info',
          title: `File reads are using ${formatTokens(readEntry.resultTokens)} tokens (${pct}%)`,
          detail: 'Reference earlier reads instead of re-reading files, and use offset and limit for large files.',
          savingsTokens: Math.round(readEntry.resultTokens * 0.3),
        })
      }
    }
  }

  if (windowTokens > 0 && data.memoryFiles.length > 0) {
    const totalMemory = data.memoryFiles.reduce((sum, file) => sum + file.tokens, 0)
    if (totalMemory >= INSTRUCTION_FILES_MIN_TOKENS && totalMemory / windowTokens >= INSTRUCTION_FILES_MIN_SHARE) {
      const pct = Math.round((totalMemory / windowTokens) * 100)
      const topFiles = [...data.memoryFiles]
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 3)
        .map(file => `${getDisplayPath(file.path)} (${formatTokens(file.tokens)})`)
        .join(', ')
      suggestions.push({
        severity: 'info',
        title: `Memory files are using ${formatTokens(totalMemory)} tokens (${pct}%)`,
        detail: `Largest: ${topFiles}. Review and prune them through /memory.`,
        savingsTokens: Math.round(totalMemory * 0.3),
      })
    }
  }

  return suggestions.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'warning' ? -1 : 1
    return (b.savingsTokens ?? 0) - (a.savingsTokens ?? 0)
  })
}
