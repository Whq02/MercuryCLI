import { writeSync } from 'node:fs'
import stringWidth from 'string-width'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { readUsageHistory, type UsageHistoryReport, type UsageTotals } from '../../cost-tracker.js'
import { DEEPSEEK_PRICING_SOURCE, DEEPSEEK_PRICING_OBSERVED_AT } from '../../services/providers/deepseek/deepseekPins.js'

const clean = (value: string): string => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?')
const count = (value: number): string => value.toLocaleString('en-US')
const hitRate = (row: UsageTotals): string => row.inputTokens > 0 ? `${(100 * row.cacheReadTokens / row.inputTokens).toFixed(1)}%` : '—'
const usd = (row: UsageTotals): string => row.turns === row.unpricedTurns && row.turns > 0 ? '—' : `$${row.costUSD.toFixed(4)}`

function projectLabels(paths: string[]): Map<string, string> {
  const parts = paths.map(path => path.replace(/\\/g, '/').split('/').filter(Boolean))
  return new Map(paths.map((path, index) => {
    const own = parts[index]!
    for (let depth = 1; depth <= own.length; depth++) {
      const label = own.slice(-depth).join('/')
      if (!parts.some((other, i) => i !== index && other.slice(-depth).join('/') === label)) return [path, label]
    }
    return [path, path]
  }))
}

export function formatUsageHistory(report: UsageHistoryReport, columns = 80): string {
  const width = Math.max(40, Math.min(160, columns))
  const lines = ['Usage history', 'Local transcripts · days in UTC · estimated USD, not invoices', '']
  const table = (title: string, rows: Array<UsageTotals & { key: string }>): void => {
    lines.push(title)
    const cells = rows.map(row => [count(row.inputTokens), count(row.outputTokens), hitRate(row), usd(row), count(row.unpricedTurns)])
    const headings = ['Input', 'Output', 'Cache hit', 'Est. USD', 'Unpriced']
    const widths = headings.map((heading, i) => Math.max(heading.length, ...cells.map(row => row[i]!.length)))
    const numericWidth = widths.reduce((a, b) => a + b, 0) + widths.length * 2
    const labelWidth = Math.max(10, width - numericWidth)
    const values = (row: string[]): string => row.map((cell, i) => cell.padStart(widths[i]!)).join('  ')
    lines.push(''.padEnd(labelWidth) + '  ' + values(headings))
    rows.forEach((row, i) => {
      const label = clean(row.key)
      if (stringWidth(label) > labelWidth) {
        lines.push(label)
        lines.push(''.padEnd(labelWidth) + '  ' + values(cells[i]!))
      } else lines.push(label + ' '.repeat(labelWidth - stringWidth(label)) + '  ' + values(cells[i]!))
    })
    lines.push('')
  }
  table('Total', [{ key: `${count(report.totals.turns)} turns`, ...report.totals }])
  if (report.totals.turns === 0) lines.push('No recorded usage in this selection.', '')
  else {
    table('By day (UTC)', report.byDay)
    table('By model', report.byModel)
    const labels = projectLabels(report.byProject.map(row => row.key))
    table('By project', report.byProject.map(row => ({ ...row, key: labels.get(row.key)! })))
    lines.push('Input includes cache reads and writes. Cache hit = reads / input.',
      'Unpriced = turns without a rate; their tokens count, their USD does not.',
      'Estimates use current local rates; older turns use their recorded time.',
      `Hourly provider observations retained: ${count(report.observations.length)}`,
      `Transcript files: ${report.filesCached} cached, ${report.filesRead} read.`)
  }
  if (report.skippedRecords > 0) lines.push(`Skipped records: ${report.skippedRecords} invalid or missing a date.`)
  for (const warning of report.warnings) lines.push(clean(warning))
  if (report.totals.turns > 0) lines.push(`DeepSeek rates checked ${DEEPSEEK_PRICING_OBSERVED_AT}:`, DEEPSEEK_PRICING_SOURCE,
    'Peak: Mon–Fri 01:00–04:00, 06:00–10:00 UTC, except public holidays.',
    'Off-peak: all other hours, at half price. Holiday calendar: 2026.',
    'Other years: peak-window prices are upper-bound estimates.')
  const wrapped: string[] = []
  for (const line of lines) {
    let part = ''
    let cells = 0
    for (const character of line) {
      const size = stringWidth(character)
      if (cells + size > width) { wrapped.push(part); part = ''; cells = 0 }
      part += character
      cells += size
    }
    wrapped.push(part)
  }
  return wrapped.join('\n') + '\n'
}

export function usageHistoryCli(opts: { json?: boolean; days?: number; project?: boolean }): void {
  const report = readUsageHistory({ ...(opts.days === undefined ? {} : { days: opts.days }), ...(opts.project ? { project: getOriginalCwd() } : {}) })
  const columns = process.stdout.columns || Number(process.env.COLUMNS) || 80
  writeSync(1, opts.json ? JSON.stringify(report, null, 2) + '\n' : formatUsageHistory(report, columns))
}
