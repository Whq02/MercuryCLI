import { crewAgentsOf, crewSettled, type CrewAgentFacts } from '../services/engine-connector/crewFacts.js'
import type { WorkRosterV1 } from '../services/engine-connector/types.js'
import type { TaskState } from '../tasks/types.js'
import { formatAgentId } from '../utils/agentId.js'
import { projectWorkRoster } from '../utils/task/workRoster.js'
import type { AppState } from './AppStateStore.js'

export type CrewLedgerRow = { facts: CrewAgentFacts; hosted: boolean; listed: boolean; cleared: boolean; stamp: string }
export type CrewLedger = Record<string, CrewLedgerRow>
export type CrewSeen = { facts: CrewAgentFacts; hosted: boolean }

type SetAppState = (updater: (prevState: AppState) => AppState) => void

export const CREW_UNLISTED_STOP_WORDS = 'its runner no longer lists it'

export function crewFactsStamp(facts: CrewAgentFacts): string {
  return JSON.stringify(facts)
}

function dismissed(task: TaskState): boolean {
  return (task as { evictAfter?: number }).evictAfter === 0
}

export function seenCrewOf(tasks: Record<string, TaskState> | undefined, roster: Pick<WorkRosterV1, 'rows'>, sessionId: string | null): CrewSeen[] {
  const kept: Record<string, TaskState> = {}
  for (const [id, task] of Object.entries(tasks ?? {})) if (!dismissed(task)) kept[id] = task
  const local = crewAgentsOf(projectWorkRoster(kept), sessionId)
  const localIds = new Set(local.map(facts => facts.id))
  const hosted = crewAgentsOf(roster.rows, sessionId).filter(facts => !localIds.has(facts.id))
  return [...local.map(facts => ({ facts, hosted: false })), ...hosted.map(facts => ({ facts, hosted: true }))]
}

export function settledUnlisted(facts: CrewAgentFacts, nowMs: number): CrewAgentFacts {
  if (!facts.running) return facts
  return {
    ...facts,
    running: false,
    status: 'killed',
    state: 'stopped',
    wait: null,
    phase: null,
    activity: null,
    pendingAsks: 0,
    stopReason: CREW_UNLISTED_STOP_WORDS,
    endedAt: facts.endedAt ?? nowMs,
  }
}

export function foldCrewLedger(
  ledger: CrewLedger,
  seen: readonly CrewSeen[],
  sessionId: string | null,
  hostedReported: boolean,
  nowMs: number,
  runnerGone = false,
): CrewLedger {
  let next: CrewLedger | null = null
  const touch = (): CrewLedger => {
    if (next === null) next = { ...ledger }
    return next
  }
  const seenIds = new Set<string>()
  for (const entry of seen) {
    const id = entry.facts.id
    seenIds.add(id)
    const stamp = crewFactsStamp(entry.facts)
    const prior = ledger[id]
    const cleared = prior?.cleared === true && !entry.facts.running
    if (prior !== undefined && prior.listed && prior.hosted === entry.hosted && prior.cleared === cleared && prior.stamp === stamp) continue
    touch()[id] = { facts: entry.facts, hosted: entry.hosted, listed: true, cleared, stamp }
  }
  for (const [id, row] of Object.entries(ledger)) {
    if (seenIds.has(id) || row.facts.sessionId !== sessionId) continue
    if (row.hosted && runnerGone) {
      delete touch()[id]
      continue
    }
    if (!row.listed) continue
    if (row.hosted && !hostedReported) continue
    if (row.cleared) {
      delete touch()[id]
      continue
    }
    const facts = settledUnlisted(row.facts, nowMs)
    touch()[id] = { ...row, facts, listed: false, stamp: crewFactsStamp(facts) }
  }
  return next ?? ledger
}

export function crewLedgerOrder(a: CrewAgentFacts, b: CrewAgentFacts): number {
  if (a.running !== b.running) return a.running ? -1 : 1
  return b.startedAt - a.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

export function sessionCrewRows(
  ledger: CrewLedger,
  seen: readonly CrewSeen[],
  sessionId: string | null,
  hostedReported: boolean,
  nowMs: number,
  runnerGone = false,
): CrewLedgerRow[] {
  const rows: CrewLedgerRow[] = []
  const seenIds = new Set<string>()
  for (const entry of seen) {
    const id = entry.facts.id
    seenIds.add(id)
    if (ledger[id]?.cleared === true && !entry.facts.running) continue
    rows.push({ facts: entry.facts, hosted: entry.hosted, listed: true, cleared: false, stamp: '' })
  }
  for (const [id, row] of Object.entries(ledger)) {
    if (seenIds.has(id) || row.cleared || row.facts.sessionId !== sessionId) continue
    if (row.hosted && runnerGone) continue
    if (row.listed && row.hosted && !hostedReported) {
      rows.push(row)
      continue
    }
    const facts = settledUnlisted(row.facts, nowMs)
    rows.push(facts === row.facts ? { ...row, listed: false } : { ...row, facts, listed: false, stamp: '' })
  }
  rows.sort((a, b) => crewLedgerOrder(a.facts, b.facts))
  return rows
}

export function crewLedgerClearable(row: Pick<CrewLedgerRow, 'facts'> | undefined): boolean {
  return row !== undefined && crewSettled(row.facts)
}

export function clearCrewLedgerRow(ledger: CrewLedger, id: string): CrewLedger {
  const row = ledger[id]
  if (row === undefined || row.cleared) return ledger
  if (!row.listed) {
    const { [id]: _gone, ...rest } = ledger
    void _gone
    return rest
  }
  return { ...ledger, [id]: { ...row, cleared: true } }
}

export function clearCrewmate(id: string, setAppState: SetAppState): boolean {
  let cleared = false
  setAppState(prev => {
    const row = prev.crewLedger[id]
    const task = prev.tasks[id]
    if ((task !== undefined && task.status === 'running') || !crewLedgerClearable(row)) return prev
    cleared = true
    const tasks = task !== undefined && task.type === 'local_agent' ? { ...prev.tasks, [id]: { ...task, retain: false, evictAfter: 0 } } : prev.tasks
    return {
      ...prev,
      tasks,
      crewLedger: clearCrewLedgerRow(prev.crewLedger, id),
      ...(prev.viewingAgentTaskId === id ? { viewingAgentTaskId: undefined, viewSelectionMode: 'none' as const } : {}),
      ...(prev.mainChatTaskId === id ? { mainChatTaskId: undefined } : {}),
    }
  })
  return cleared
}
