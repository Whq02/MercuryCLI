// ============================================================================
//  scripts/mission-runner/live/aggregate.ts — deterministic aggregation.
//
//  Raw JSONL rows → the per-policy and per-(policy × family) aggregate.
//  Deterministic: byte-stable for a given input set (sorted keys, fixed
//  formatting, no wall-clock). Failed, timed-out and indeterminate runs are
//  COUNTED — never hidden; a failed grader can never aggregate
//  as success (§14).
//
//  CLI: bun aggregate.ts <rows.jsonl> [--md]
// ============================================================================
import { readFileSync } from 'node:fs'
import type { HelixRunRow } from './runner.js'

export interface PolicyAggregate {
  policyId: string
  runs: number
  accepted: number
  rejected: number
  incomplete: number
  indeterminate: number
  notApplicable: number
  acceptedRate: number | null
  incorrectClaims: number
  medianWallSeconds: number | null
  meanTurns: number | null
  outputTokensPerAccepted: number | null
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function round(value: number | null, places = 3): number | null {
  if (value === null || Number.isNaN(value)) return null
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

/** Supersede view: the highest runIndex per (taskId, policyId) wins — the
 *  recorded correction path for grader-bug-class re-runs. Raw rows are never
 *  deleted; this is a REPORTING projection. */
export function latestRows(rows: HelixRunRow[]): HelixRunRow[] {
  const byCell = new Map<string, HelixRunRow>()
  for (const row of rows) {
    const key = row.taskId + '|' + row.policyId
    const prior = byCell.get(key)
    if (!prior || (row.runIndex ?? 1) >= (prior.runIndex ?? 1)) byCell.set(key, row)
  }
  return [...byCell.values()].sort((a, b) =>
    a.taskId === b.taskId ? (a.policyId < b.policyId ? -1 : 1) : a.taskId < b.taskId ? -1 : 1,
  )
}

export function decodeRows(text: string): HelixRunRow[] {
  const rows: HelixRunRow[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const raw = JSON.parse(line) as HelixRunRow
    if (typeof raw.taskId !== 'string' || typeof raw.policyId !== 'string' || typeof raw.status !== 'string') {
      throw new Error('undecodable run row: ' + line.slice(0, 120))
    }
    // The §14 law at the codec: an accepted row must carry a passing grader.
    if (raw.status === 'accepted' && raw.graderComponents?.some(c => !c.pass)) {
      throw new Error('row claims accepted over a failing grader component: ' + raw.taskId)
    }
    rows.push(raw)
  }
  return rows
}

function aggregateGroup(rows: HelixRunRow[], policyId: string): PolicyAggregate {
  const executed = rows.filter(r => r.status !== 'not-applicable')
  const accepted = executed.filter(r => r.status === 'accepted')
  const walls = executed.map(r => r.wallSeconds).filter((v): v is number => typeof v === 'number')
  const turns = executed.map(r => r.numTurns).filter((v): v is number => typeof v === 'number')
  const acceptedOut = accepted
    .map(r => r.outputTokens)
    .filter((v): v is number => typeof v === 'number')
  return {
    policyId,
    runs: executed.length,
    accepted: accepted.length,
    rejected: executed.filter(r => r.status === 'rejected').length,
    incomplete: executed.filter(r => r.status === 'incomplete').length,
    indeterminate: executed.filter(r => r.status === 'indeterminate').length,
    notApplicable: rows.length - executed.length,
    acceptedRate: executed.length === 0 ? null : round(accepted.length / executed.length),
    incorrectClaims: executed.filter(r => r.incorrectClaim).length,
    medianWallSeconds: round(median(walls)),
    meanTurns: turns.length === 0 ? null : round(turns.reduce((a, b) => a + b, 0) / turns.length),
    outputTokensPerAccepted:
      acceptedOut.length === 0 ? null : round(acceptedOut.reduce((a, b) => a + b, 0) / acceptedOut.length, 0),
  }
}

export function aggregate(rows: HelixRunRow[]): {
  corpusDigests: string[]
  artifactTrees: string[]
  rowCount: number
  byPolicy: PolicyAggregate[]
  byPolicyFamily: (PolicyAggregate & { family: number })[]
} {
  const policies = [...new Set(rows.map(r => r.policyId))].sort()
  const byPolicy = policies.map(p => aggregateGroup(rows.filter(r => r.policyId === p), p))
  const byPolicyFamily: (PolicyAggregate & { family: number })[] = []
  for (const policy of policies) {
    const families = [...new Set(rows.filter(r => r.policyId === policy).map(r => r.family))].sort(
      (a, b) => a - b,
    )
    for (const family of families) {
      byPolicyFamily.push({
        ...aggregateGroup(rows.filter(r => r.policyId === policy && r.family === family), policy),
        family,
      })
    }
  }
  return {
    corpusDigests: [...new Set(rows.map(r => r.corpusDigest))].sort(),
    artifactTrees: [...new Set(rows.map(r => r.artifactTree))].sort(),
    rowCount: rows.length,
    byPolicy,
    byPolicyFamily,
  }
}

export function renderMarkdown(result: ReturnType<typeof aggregate>): string {
  const lines: string[] = []
  lines.push('| policy | runs | accepted | rate | rejected | incomplete | indet | NA | claims | median wall s | mean turns | out-tok/accepted |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const p of result.byPolicy) {
    lines.push(
      '| ' +
        [
          p.policyId,
          p.runs,
          p.accepted,
          p.acceptedRate ?? '—',
          p.rejected,
          p.incomplete,
          p.indeterminate,
          p.notApplicable,
          p.incorrectClaims,
          p.medianWallSeconds ?? '—',
          p.meanTurns ?? '—',
          p.outputTokensPerAccepted ?? '—',
        ].join(' | ') +
        ' |',
    )
  }
  return lines.join('\n')
}

if (import.meta.main) {
  const [file] = process.argv.slice(2).filter(a => !a.startsWith('--'))
  if (!file) {
    console.error('usage: aggregate.ts <rows.jsonl> [--md] [--latest]')
    process.exit(2)
  }
  const decoded = decodeRows(readFileSync(file, 'utf8'))
  const result = aggregate(process.argv.includes('--latest') ? latestRows(decoded) : decoded)
  if (process.argv.includes('--md')) {
    console.log(renderMarkdown(result))
  } else {
    console.log(JSON.stringify(result, null, 2))
  }
}
