// ============================================================================
//  scripts/mission-runner/live/weakness.ts — H5 weakness mining (deterministic).
// ----------------------------------------------------------------------------
//  Reads development/calibration raw rows and surfaces REPEATED failure
//  clusters (never single flukes): per (family × policy) rejection clusters,
//  incorrect-claim sites, reviewer-vs-grader disagreements and timeout
//  clusters, ranked by observed frequency. The output is the evidence a §10
//  candidate cites — the candidate author never invents a weakness.
//
//  CLI: bun weakness.ts <rows.jsonl> [--min 2]
// ============================================================================
import { readFileSync } from 'node:fs'
import { decodeRows } from './aggregate.js'

export interface WeaknessCluster {
  kind: 'rejection' | 'incorrect-claim' | 'timeout' | 'reviewer-disagreement'
  family: number
  policyId: string
  count: number
  taskIds: string[]
  evidence: string[]
}

export function mineWeaknesses(rowsText: string, minCount = 2): WeaknessCluster[] {
  const rows = decodeRows(rowsText).filter(r => r.status !== 'not-applicable')
  const clusters = new Map<string, WeaknessCluster>()
  const bump = (
    kind: WeaknessCluster['kind'],
    family: number,
    policyId: string,
    taskId: string,
    evidence: string,
  ): void => {
    const key = kind + '|' + family + '|' + policyId
    const cluster = clusters.get(key) ?? { kind, family, policyId, count: 0, taskIds: [], evidence: [] }
    cluster.count += 1
    if (!cluster.taskIds.includes(taskId)) cluster.taskIds.push(taskId)
    if (cluster.evidence.length < 6) cluster.evidence.push(evidence)
    clusters.set(key, cluster)
  }
  for (const row of rows) {
    const failedComponents = (row.graderComponents ?? [])
      .filter(c => !c.pass)
      .map(c => c.name + ': ' + c.detail.slice(0, 160))
    if (row.status === 'rejected' || row.status === 'indeterminate') {
      bump('rejection', row.family, row.policyId, row.taskId, row.taskId + ' — ' + (failedComponents[0] ?? 'no component detail'))
    }
    if (row.status === 'incomplete') {
      bump('timeout', row.family, row.policyId, row.taskId, row.taskId + ' — ceiling ' + (row.wallSeconds ?? '?') + 's')
    }
    if (row.incorrectClaim) {
      bump('incorrect-claim', row.family, row.policyId, row.taskId, row.taskId + ' — claimed success over: ' + (failedComponents[0] ?? '?'))
    }
    if (row.reviewerDisagreesWithGrader) {
      bump('reviewer-disagreement', row.family, row.policyId, row.taskId, row.taskId + ' — reviewer ' + (row.reviewerVerdict ?? '?') + ' vs grader ' + row.status)
    }
  }
  return [...clusters.values()]
    .filter(c => c.count >= minCount)
    .sort((a, b) => b.count - a.count || a.family - b.family || (a.policyId < b.policyId ? -1 : 1))
}

if (import.meta.main) {
  const [file] = process.argv.slice(2).filter(a => !a.startsWith('--'))
  const minAt = process.argv.indexOf('--min')
  const min = minAt >= 0 ? Number(process.argv[minAt + 1]) : 2
  if (!file) {
    console.error('usage: weakness.ts <rows.jsonl> [--min N]')
    process.exit(2)
  }
  console.log(JSON.stringify(mineWeaknesses(readFileSync(file, 'utf8'), min), null, 2))
}
