import { partiallySanitizeUnicode } from '../../platform/text/unicodeSanitization.js'
import { isProcessAlive } from '../control/ownerWatch.js'
import { updateConcourseWorkers, readSessionWorkers } from './store.js'
import { stampedTerminalPid, withdrawTerminalParkRequest, type ConcourseWorkerRecordV1 } from './record.js'

export type ConcourseTagOutcome =
  | { outcome: 'applied' }
  | { outcome: 'noop'; reason: 'already-granted' | 'not-granted' }
  | { outcome: 'refused'; reason: 'unknown-session' | 'cap-one'; detail?: string }

export function grantConcourseWorkflows(
  sessionId: string,
  by: string,
  dir?: string,
): ConcourseTagOutcome {
  let out: ConcourseTagOutcome = { outcome: 'refused', reason: 'unknown-session' }
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(
      r => r.sessionId === sessionId && r.endedAt === undefined,
    )
    if (!rec) return
    if (rec.workflowsAllowed === true) {
      out = { outcome: 'noop', reason: 'already-granted' }
      return
    }
    const holder = Object.values(workers).find(
      r => r.endedAt === undefined && r.workflowsAllowed === true,
    )
    if (holder) {
      out = {
        outcome: 'refused',
        reason: 'cap-one',
        detail: `"${holder.title ?? holder.runnerId}" already holds crewmates-allowed — one tagged session at a time; revoke it first`,
      }
      return
    }
    rec.workflowsAllowed = true
    rec.workflowsGrantedBy = by
    rec.workflowsGrantedAt = Date.now()
    out = { outcome: 'applied' }
  }, dir)
  return out
}

export function revokeConcourseWorkflows(
  sessionId: string,
  by: string,
  dir?: string,
): ConcourseTagOutcome {
  void by
  let out: ConcourseTagOutcome = { outcome: 'refused', reason: 'unknown-session' }
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(
      r => r.sessionId === sessionId && r.endedAt === undefined,
    )
    if (!rec) return
    if (rec.workflowsAllowed !== true) {
      out = { outcome: 'noop', reason: 'not-granted' }
      return
    }
    delete rec.workflowsAllowed
    delete rec.workflowsGrantedBy
    delete rec.workflowsGrantedAt
    out = { outcome: 'applied' }
  }, dir)
  return out
}

export type ConcourseFocusOutcome =
  | { outcome: 'applied'; runnerId: string; cleared: string[] }
  | { outcome: 'noop'; reason: 'already-focused' | 'not-focused' }
  | { outcome: 'refused'; reason: 'unknown-session' }

export function nextLiveCockpitOwner(exceptPid: number | null, dir?: string, since = 0): number | undefined {
  let best: { pid: number; at: number } | undefined
  for (const rec of Object.values(readSessionWorkers(dir))) {
    if (rec.endedAt !== undefined || rec.parkedAt !== undefined) continue
    for (const [by, at] of [
      [rec.focusedBy, rec.focusedAt] as const,
      [rec.attachedBy, rec.attachedAt] as const,
      ...(rec.focusedAlso ?? []).map(stamp => [stamp.by, stamp.at] as const),
    ]) {
      const pid = stampedTerminalPid(by)
      if (pid === undefined || pid === exceptPid || !isProcessAlive(pid)) continue
      const stampedAt = at ?? 0
      if (stampedAt < since) continue
      if (best === undefined || stampedAt < best.at) best = { pid, at: stampedAt }
    }
  }
  return best?.pid
}

function forgetVisitor(rec: ConcourseWorkerRecordV1, by: string): boolean {
  const earlier = rec.focusedAlso ?? []
  const rest = earlier.filter(stamp => stamp.by !== by)
  if (rest.length > 0) rec.focusedAlso = rest
  else delete rec.focusedAlso
  return rest.length < earlier.length
}

function terminalLives(by: string): boolean {
  const pid = stampedTerminalPid(by)
  return pid !== undefined && isProcessAlive(pid)
}

export function terminalsFocusing(rec: ConcourseWorkerRecordV1): string[] {
  const holder = rec.focusedAt !== undefined && rec.focusedBy !== undefined ? [rec.focusedBy] : []
  return [...(rec.focusedAlso ?? []).map(stamp => stamp.by), ...holder].filter(terminalLives)
}

export function handFocusBack(rec: ConcourseWorkerRecordV1): void {
  const earlier = (rec.focusedAlso ?? []).filter(stamp => terminalLives(stamp.by))
  const next = earlier.pop()
  if (earlier.length > 0) rec.focusedAlso = earlier
  else delete rec.focusedAlso
  if (next === undefined) {
    delete rec.focusedAt
    delete rec.focusedBy
    delete rec.terminalApplication
    return
  }
  rec.focusedAt = next.at
  rec.focusedBy = next.by
  rec.terminalApplication = next.terminalApplication ?? null
}

export function focusConcourseSession(sessionId: string, by: string, dir?: string, terminalApplication?: { identity: string; name: string; windowId?: string | null; tty?: string | null } | null): ConcourseFocusOutcome {
  let out: ConcourseFocusOutcome = { outcome: 'refused', reason: 'unknown-session' }
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(r => r.sessionId === sessionId && r.endedAt === undefined)
    if (!rec) return
    const cleared: string[] = []
    for (const other of Object.values(workers)) {
      if (other === rec || other.endedAt !== undefined) continue
      forgetVisitor(other, by)
      if (other.focusedBy !== by) continue
      handFocusBack(other)
      cleared.push(other.runnerId)
    }
    const terminalChanged = terminalApplication !== undefined && (rec.terminalApplication?.identity !== terminalApplication?.identity || rec.terminalApplication?.name !== terminalApplication?.name || rec.terminalApplication?.windowId !== terminalApplication?.windowId || rec.terminalApplication?.tty !== terminalApplication?.tty)
    if (rec.focusedAt !== undefined && rec.focusedBy === by && cleared.length === 0 && !terminalChanged) {
      out = { outcome: 'noop', reason: 'already-focused' }
      return
    }
    if (rec.focusedBy !== undefined && rec.focusedBy !== by && rec.focusedAt !== undefined) {
      const stepped = { by: rec.focusedBy, at: rec.focusedAt, ...(rec.terminalApplication !== undefined ? { terminalApplication: rec.terminalApplication } : {}) }
      rec.focusedAlso = [...(rec.focusedAlso ?? []).filter(stamp => stamp.by !== stepped.by), stepped]
    }
    forgetVisitor(rec, by)
    if (rec.focusedBy !== by || terminalApplication !== undefined) rec.terminalApplication = terminalApplication ?? null
    rec.focusedAt = Date.now()
    rec.focusedBy = by
    withdrawTerminalParkRequest(rec)
    out = { outcome: 'applied', runnerId: rec.runnerId, cleared }
  }, dir)
  return out
}

export function blurConcourseSession(sessionId: string, by: string, dir?: string): ConcourseFocusOutcome {
  let out: ConcourseFocusOutcome = { outcome: 'refused', reason: 'unknown-session' }
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(r => r.sessionId === sessionId && r.endedAt === undefined)
    if (!rec) return
    if (rec.focusedAt === undefined || rec.focusedBy !== by) {
      out = forgetVisitor(rec, by) ? { outcome: 'applied', runnerId: rec.runnerId, cleared: [] } : { outcome: 'noop', reason: 'not-focused' }
      return
    }
    handFocusBack(rec)
    out = { outcome: 'applied', runnerId: rec.runnerId, cleared: [rec.runnerId] }
  }, dir)
  return out
}

export function setConcourseSessionTitle(
  sessionId: string,
  rawTitle: string,
  by: string,
  source: 'operator' | 'minted',
  dir?: string,
): { outcome: 'applied' | 'noop' | 'refused'; detail?: string } {
  void by
  const title = partiallySanitizeUnicode(rawTitle).replace(/\s+/g, ' ').trim().slice(0, 200)
  if (title.length === 0) return { outcome: 'refused', detail: 'a title needs words' }
  let out: { outcome: 'applied' | 'noop' | 'refused'; detail?: string } = {
    outcome: 'refused',
    detail: 'unknown-session: no live worker record owns this session',
  }
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(r => r.sessionId === sessionId && r.endedAt === undefined)
    if (!rec) return
    if (source === 'minted') {
      if (rec.titleMintedAt !== undefined) {
        out = { outcome: 'noop', detail: 'minted once already — the mint never runs twice' }
        return
      }
      if ((rec.title ?? '').trim().length > 0) {
        out = { outcome: 'noop', detail: 'a title already stands — the mint fills empty titles only' }
        return
      }
      rec.titleMintedAt = Date.now()
    }
    rec.title = title
    rec.titleSource = source
    out = { outcome: 'applied' }
  }, dir)
  return out
}
