
import { isProcessAlive } from '../../daemon/ownerWatch.js'
import { listConcourseWorkers } from '../../daemon/concourseSupervisor.js'
import { getProjectDir } from '../../utils/sessionStoragePortable.js'
import { inProject, projectDisplayName, type ProjectIdentity } from '../../utils/bootCardFacts.js'
import type { ConcourseElsewhereV1, ConcourseRowV1 } from '../../components/concourse/contracts.js'

export const ELSEWHERE_CAP = 3

export function isRunningState(state: ConcourseRowV1['state'], alive: boolean): boolean {
  return state === 'working' || state === 'ready-to-review' || state === 'attached' || (state === 'needs-you' && alive)
}

export function projectActivity(
  rows: ReadonlyArray<Pick<ConcourseRowV1, 'sessionId' | 'state' | 'workspaceDir'>>,
  opts: { current: ProjectIdentity; excludeSessionId?: string | null; aliveOf?: (sessionId: string) => boolean },
): ConcourseElsewhereV1[] {
  const byKey = new Map<string, ConcourseElsewhereV1>()
  for (const row of rows) {
    if (row.workspaceDir === undefined || row.workspaceDir.length === 0) continue
    if (row.sessionId === opts.excludeSessionId) continue
    if (inProject(opts.current, row.workspaceDir)) continue
    let key: string
    try {
      key = getProjectDir(row.workspaceDir)
    } catch {
      continue
    }
    let entry = byKey.get(key)
    if (entry === undefined) {
      entry = { dir: row.workspaceDir, key, name: projectDisplayName(row.workspaceDir), running: 0, needsYou: 0, finished: 0 }
      byKey.set(key, entry)
    }
    if (isRunningState(row.state, opts.aliveOf?.(row.sessionId) ?? true)) entry.running += 1
    if (row.state === 'needs-you') entry.needsYou += 1
    if (row.state === 'ready-to-review') entry.finished += 1
  }
  return [...byKey.values()]
    .filter(p => p.running + p.needsYou + p.finished > 0)
    .sort((a, b) => activityOf(b) - activityOf(a) || a.name.localeCompare(b.name))
}

export function activityOf(p: ConcourseElsewhereV1): number {
  return p.running + p.needsYou + p.finished
}

export function elsewhereLine(p: ConcourseElsewhereV1): string {
  const needs = `${p.needsYou} need${p.needsYou === 1 ? 's' : ''} you`
  const lead = p.running > 0 ? `${p.running} running` : p.finished > 0 ? `${p.finished} finished` : needs
  const rest: string[] = []
  if (p.running > 0 && p.needsYou > 0) rest.push(needs)
  if (p.running > 0 && p.finished > 0) rest.push(`${p.finished} finished`)
  if (p.running === 0 && p.finished > 0 && p.needsYou > 0) rest.push(needs)
  return `${lead} in ${p.name}${rest.length > 0 ? ` · ${rest.join(' · ')}` : ''}`
}

export async function runningByProjectKey(recordsDir?: string): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  try {
    const { concourseRecordState } = await import('./concourseSnapshot.js')
    for (const rec of listConcourseWorkers(null, recordsDir)) {
      const alive = rec.pid !== undefined && isProcessAlive(rec.pid)
      const state = concourseRecordState(rec, { needsYou: rec.crash !== undefined, alive })
      if (!isRunningState(state, alive)) continue
      let key: string
      try {
        key = getProjectDir(rec.workspaceId)
      } catch {
        continue
      }
      out.set(key, (out.get(key) ?? 0) + 1)
    }
  } catch {
  }
  return out
}
