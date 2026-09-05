import type { ConcourseWorkerRecordV1 } from '../../daemon/concourseSupervisor.js'
import type { WorkRowV1 } from './types.js'

export function workRowRuns(row: WorkRowV1): boolean {
  return row.status === 'running' || row.status === 'pending'
}

export interface WorkCountsV1 {
  workflows: number
  agents: number
  teammates: number
  shells: number
  asks: number
}

export function workCounts(rows: readonly WorkRowV1[]): WorkCountsV1 {
  const counts: WorkCountsV1 = { workflows: 0, agents: 0, teammates: 0, shells: 0, asks: 0 }
  for (const row of rows) {
    if (!workRowRuns(row)) continue
    switch (row.kind) {
      case 'workflow':
        counts.workflows += 1
        break
      case 'agent':
        counts.agents += 1
        break
      case 'teammate':
        counts.teammates += 1
        break
      case 'shell':
      case 'monitor':
        counts.shells += 1
        break
      default:
        break
    }
    counts.asks += row.pendingAsks ?? 0
  }
  return counts
}

export function workChipLine(counts: WorkCountsV1): string | null {
  const parts: string[] = []
  if (counts.workflows > 0) parts.push(`${counts.workflows} workflow${counts.workflows === 1 ? '' : 's'}`)
  if (counts.agents > 0) parts.push(`${counts.agents} agent${counts.agents === 1 ? '' : 's'}`)
  if (counts.teammates > 0) parts.push(`${counts.teammates} named agent${counts.teammates === 1 ? '' : 's'}`)
  if (counts.shells > 0) parts.push(`${counts.shells} shell${counts.shells === 1 ? '' : 's'}`)
  if (parts.length === 0) return null
  const line = parts.join(' · ')
  return counts.asks > 0 ? `${line} · ${counts.asks} ask${counts.asks === 1 ? '' : 's'}` : line
}

export function workWaitingWords(counts: WorkCountsV1): string | null {
  const line = workChipLine(counts)
  return line === null ? null : `waiting on ${line}`
}

export function runnerRecordAlive(
  rec: Pick<ConcourseWorkerRecordV1, 'endedAt' | 'attachedAt' | 'pid'>,
  alive: (pid: number) => boolean,
): boolean {
  if (rec.endedAt !== undefined) return false
  if (rec.attachedAt !== undefined) return true
  return rec.pid !== undefined && alive(rec.pid)
}
