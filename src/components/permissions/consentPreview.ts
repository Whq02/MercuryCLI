// The consent card's command bound: the shell consent
// cards printed the command with verbose:true — uncapped — so a here-string
// or heredoc pushed the card's OWN Yes/No options and the composer under it
// off the pane, and a blind ↵ answered a question the operator never saw
// (the MGR-1 stranding class, on the most safety-critical surface in the
// product). The bound is HEIGHT-derived, not a blind cap: the preview may
// spend the terminal rows minus the card's chrome + options + composer
// reserve, counting WRAPPED rows through the one width oracle, and the cut
// is NAMED — "+N more lines (the whole command runs)" — so what is hidden
// is never silently hidden.

import { stringWidth } from '../../ink/stringWidth.js'

/** Rows the card's chrome + options + legend + the composer beneath need. */
const CONSENT_CHROME_RESERVE = 14
const CONSENT_PREVIEW_MIN_ROWS = 6

export function consentPreviewBudget(termRows: number): number {
  return Math.max(CONSENT_PREVIEW_MIN_ROWS, termRows - CONSENT_CHROME_RESERVE)
}

export function consentCommandPreview(
  command: string,
  columns: number,
  termRows: number,
): { text: string; hiddenLines: number } {
  const width = Math.max(20, columns - 8)
  const maxRows = consentPreviewBudget(termRows)
  const lines = command.split('\n')
  let rows = 0
  let take = 0
  for (const line of lines) {
    const cost = Math.max(1, Math.ceil(Math.max(1, stringWidth(line)) / width))
    if (rows + cost > maxRows) break
    rows += cost
    take += 1
  }
  if (take === lines.length) return { text: command, hiddenLines: 0 }
  if (take === 0) {
    // A single monster line: keep its head, sized to the row budget (an
    // approximate char slice — the ellipsis and the hidden count carry the
    // truth), and count the whole rest as hidden.
    const headChars = Math.max(width, width * maxRows - 1)
    return { text: `${(lines[0] ?? '').slice(0, headChars)}…`, hiddenLines: lines.length }
  }
  return { text: lines.slice(0, take).join('\n'), hiddenLines: lines.length - take }
}
