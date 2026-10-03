export interface PlaneBootFactsV1 {
  selfPid: number
  selfBuildTree: string | null
  successorOf: number | null
  handoverFrom: number | null
  lockHolder: number | null
  record: { pid: number; buildTree: string | null } | null
  plane: { pid: number; buildTree: string | null } | null
}

export type PlaneBootDecisionV1 =
  | { road: 'serve'; why: string }
  | { road: 'handover'; from: number; why: string }
  | { road: 'wait-lock'; for: number; why: string }
  | { road: 'stand-down'; why: string }
  | { road: 'refuse'; why: string }

export function sameBuildTree(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '') return false
  return a.slice(0, 12) === b.slice(0, 12)
}

export function decidePlaneBoot(facts: PlaneBootFactsV1): PlaneBootDecisionV1 {
  const other = (pid: number | null | undefined): number | null => (typeof pid === 'number' && pid > 0 && pid !== facts.selfPid ? pid : null)
  const serverPid = other(facts.plane?.pid) ?? other(facts.record?.pid)
  const serverBuild = facts.plane !== null && other(facts.plane.pid) !== null ? facts.plane.buildTree : (facts.record?.buildTree ?? null)
  const lockHolder = other(facts.lockHolder)
  if (serverPid !== null) {
    if (facts.handoverFrom !== null) {
      if (facts.handoverFrom !== serverPid) return { road: 'stand-down', why: `the plane moved to pid ${serverPid} since the handover from pid ${facts.handoverFrom} was asked` }
      if (sameBuildTree(serverBuild, facts.selfBuildTree)) return { road: 'stand-down', why: `the predecessor pid ${serverPid} already runs this build — nothing to move` }
      return { road: 'handover', from: serverPid, why: `the predecessor pid ${serverPid} serves the plane on another build` }
    }
    if (facts.successorOf !== null) {
      if (facts.successorOf === serverPid) return { road: 'wait-lock', for: serverPid, why: `the predecessor pid ${serverPid} still answers while it leaves` }
      return { road: 'stand-down', why: `the plane is served by pid ${serverPid}` }
    }
    return { road: 'refuse', why: `pid ${serverPid} serves this config home` }
  }
  if (lockHolder === null) return { road: 'serve', why: 'nothing serves the plane and the daemon lock is free' }
  if (facts.successorOf === lockHolder) return { road: 'wait-lock', for: lockHolder, why: `the predecessor pid ${lockHolder} still holds the daemon lock while it leaves` }
  return { road: 'handover', from: lockHolder, why: `pid ${lockHolder} holds the daemon lock but serves no plane — it keeps what it holds` }
}
