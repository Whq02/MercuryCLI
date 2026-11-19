import type { DapSession } from '../dapClient.js'

export function root(session: DapSession): DapSession {
  let s: DapSession = session
  while (s.parentSession) s = s.parentSession
  return s
}

export function treeSessions(session: DapSession): DapSession[] {
  const out: DapSession[] = [session]
  for (const child of session.children) out.push(...child.treeSessions())
  return out
}

export function treeTerminated(session: DapSession, hostsDebuggee: boolean): boolean {
  if (session.terminated) return true
  if (hostsDebuggee) return false
  return session.children.length > 0 && session.children.every(c => c.treeTerminated())
}

export function treeStopped(session: DapSession, sinceStamp: number): DapSession | null {
  let best: DapSession | null = null
  for (const s of session.treeSessions()) {
    if (s.alive && s.lastStopped && s.lastStoppedAt > sinceStamp && (best === null || s.lastStoppedAt > best.lastStoppedAt)) {
      best = s
    }
  }
  return best
}

export function treeNewestStopStamp(session: DapSession): number {
  let max = 0
  for (const s of session.treeSessions()) {
    if (s.lastStoppedAt > max) max = s.lastStoppedAt
  }
  return max
}

export function treeVerifiedBreakpoints(session: DapSession): Map<
  string,
  Array<{ line: number; verified: boolean; message?: string; id?: number; verifier?: string }>
> {
  const out = new Map<string, Array<{ line: number; verified: boolean; message?: string; id?: number; verifier?: string }>>()
  for (const s of session.treeSessions()) {
    for (const [path, rows] of s.breakpoints) {
      const cur = out.get(path)
      if (!cur) {
        out.set(
          path,
          rows.map(r => ({ ...r, ...(r.verified ? { verifier: s.label } : {}) })),
        )
        continue
      }
      rows.forEach((r, i) => {
        const prev = cur[i]
        if (!prev) cur[i] = { ...r, ...(r.verified ? { verifier: s.label } : {}) }
        else if (!prev.verified && r.verified) cur[i] = { ...r, verifier: s.label }
      })
    }
  }
  return out
}

export function treeVerifiedFunctionBreakpoints(session: DapSession): Array<{ name: string; verified: boolean; message?: string; id?: number; verifier?: string }> {
  const out: Array<{ name: string; verified: boolean; message?: string; id?: number; verifier?: string }> = []
  for (const s of session.treeSessions()) {
    s.functionBreakpoints.forEach((r, i) => {
      const prev = out[i]
      if (!prev) out[i] = { ...r, ...(r.verified ? { verifier: s.label } : {}) }
      else if (!prev.verified && r.verified) out[i] = { ...r, verifier: s.label }
    })
  }
  return out
}

export function treeExitDetail(session: DapSession): string {
  const own = session.exitDetail.startsWith('debuggee exited') ? session.exitDetail : ''
  if (own !== '') return own
  for (const child of session.children) {
    const detail = child.treeExitDetail()
    if (detail !== '') return detail
  }
  return session.exitDetail
}

export function debuggeeEndDetail(session: DapSession): string {
  const tree = session.treeExitDetail()
  if (tree.startsWith('debuggee exited')) return tree
  for (let index = session.output.length - 1; index >= 0; index--) {
    const printed = /Process exited with code (\d+)/.exec(session.output[index] ?? '')
    if (printed !== null) return `debuggee exited (code ${printed[1]})`
  }
  return tree !== '' ? tree : 'debuggee ended (no non-zero exit code reported)'
}

export function debugTarget(session: DapSession): { session: DapSession } | { ambiguousDetail: string } {
  const stopped = session.treeStopped()
  if (stopped) return { session: stopped }
  const liveDescendants = session.treeSessions().filter(s => s !== session && s.alive)
  if (liveDescendants.length === 1) {
    const only = liveDescendants[0]
    if (only) return { session: only }
  }
  if (liveDescendants.length === 0) return { session }
  const listing = session.treeSessions()
    .map(
      s =>
        `${s.label}: ${s.terminated ? 'terminated' : s.lastStopped ? `stopped (${s.lastStopped.reason})` : 'running'}`,
    )
    .join(' · ')
  return {
    ambiguousDetail:
      `${liveDescendants.length} child sessions are live and none is stopped — refusing to guess a target. ` +
      `tree: ${listing}. Wait for a stop (op:"status" shows the tree), or op:"disconnect" to end the session`,
  }
}
