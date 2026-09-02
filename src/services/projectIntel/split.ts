
import { assembleContextCapsule } from './capsule.js'
import { projectImpact } from './impact.js'
import { projectIntelEnabled, type SnapshotGeneration } from './contracts.js'
import { getProjectSnapshot } from './snapshot.js'

export interface WorkSplitSuggestion {
  advisory: true
  generation: SnapshotGeneration
  perTask: Array<{
    task: string
    files: string[]
    tests: string[]
  }>
  contested: Array<{ path: string; tasks: number[]; note: string }>
  caps: { omissions: string[] }
}

export function suggestWorkSplit(workspace: string, tasks: string[]): WorkSplitSuggestion | null {
  if (!projectIntelEnabled()) return null
  const read = getProjectSnapshot(workspace)
  if (!read || tasks.length === 0) return null

  const omissions: string[] = []
  const perTask = tasks.map(task => {
    const capsule = assembleContextCapsule({
      workspace,
      task,
      budget: { maxItems: 16 },
    })
    const files = new Set<string>(
      (capsule?.items ?? []).filter(i => i.tier <= 3).map(i => i.path),
    )
    const tests = new Set<string>()
    for (const f of [...files].slice(0, 6)) {
      const impact = projectImpact(workspace, f)
      for (const t of impact?.established.tests ?? []) tests.add(t)
    }
    if (capsule && capsule.caps.omitted.count > 0) {
      omissions.push(`task '${task.slice(0, 40)}…': ${capsule.caps.omitted.count} capsule candidate(s) omitted`)
    }
    return { task, files: [...files].sort(), tests: [...tests].sort() }
  })

  const claim = new Map<string, number[]>()
  perTask.forEach((entry, index) => {
    for (const p of [...entry.files, ...entry.tests]) {
      const owners = claim.get(p) ?? []
      owners.push(index)
      claim.set(p, owners)
    }
  })
  const contested = [...claim.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([path, owners]) => ({
      path,
      tasks: owners,
      note: `needed by ${owners.length} streams — sequence it (one edits, others wait) or transfer through the zone owner`,
    }))
    .sort((x, y) => x.path.localeCompare(y.path))

  return {
    advisory: true,
    generation: read.snapshot.generation,
    perTask,
    contested,
    caps: { omissions },
  }
}
