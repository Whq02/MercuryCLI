import { workRowRuns } from '../../engine/connector/workCounts.js'
import type { WorkRowV1 } from '../../engine/connector/types.js'
import type { SeatPermissionMode } from '../runner-link/headlessRun.js'
import { getProjectDir } from '../../sessions/transcripts/paths.js'
import { writeSessionCloseReceipts } from '../switchboard/sessionReceipts.js'
import type { SessionKind } from './sessionKind.js'
import type { WorkspaceIsolation } from './admission.js'
import { errorMessage } from '../../platform/errors/errors.js'

export interface ConcourseWorkerRecordV1 {
  schema: 1
  runnerId: string
  sessionId: string
  workspaceId: string
  isolation: WorkspaceIsolation
  modelKey: string
  keyless?: true
  agentName?: string
  seatsMax?: 1 | 2
  effort?: string
  permissionMode?: SeatPermissionMode
  permissionModeTyped?: true
  bypassConsent?: true
  kind?: SessionKind
  spawnedAt: number
  endedAt?: number
  pausedAt?: number
  pausedBy?: string
  pendingModelKey?: string
  pendingEffort?: string
  pendingKitEdits?: Array<{ edit: import('../session-seat/sessionKit.js').SessionKitEditV1; by: string }>
  spawnSwitches?: Partial<Record<'subagents' | 'workflows', 'on' | 'off'>>
  pendingSpawnSwitches?: Array<{ kind: 'subagents' | 'workflows'; on: boolean; by: string }>
  lastLiveAt: number
  pid?: number
  procStart?: string
  lastDeliveryAt?: number
  lastTurnSettledAt?: number
  activity?: {
    state: 'working' | 'waiting' | 'idle'
    subagents: number
    description: string
    lastTurnAt: number | null
  }
  bornBlankAt?: number
  resumedAtRestAt?: number
  birthKey?: string
  settingsSnapshot?: import('../../platform/substrate/startupMenu.js').SessionEffectiveSettingsSnapshotV1
  branchName?: string
  worktreePath?: string
  workspaceKind?: 'git' | 'plain-folder'
  title?: string
  titleSource?: 'operator' | 'minted'
  titleMintedAt?: number
  attachedAt?: number
  attachedBy?: string
  attachRequestedAt?: number
  attachRequestedBy?: string
  lastAttachGrantAt?: number
  stoppedAt?: number
  stoppedBy?: string
  turnCutAt?: number
  turnCutBy?: string
  stopRequestedAt?: number
  stopRequestedBy?: string
  stopRequestedRetired?: ConcourseWorkerRecordV1['retired']
  retired?: { reason: 'idle-empty'; idleMs: number; thresholdMs: number; at: number }
  crash?: { at: number; reason: string; respawning: boolean }
  runnerArgv?: string[]
  workflowsAllowed?: true
  workflowsGrantedBy?: string
  workflowsGrantedAt?: number
  focusedAt?: number
  focusedBy?: string
  focusedAlso?: Array<{ by: string; at: number; terminalApplication?: ConcourseWorkerRecordV1['terminalApplication'] }>
  terminalApplication?: { identity: string; name: string; windowId?: string | null; tty?: string | null } | null
  parkedAt?: number
  parkedBy?: string
  parkReason?: string
  parkRequestedAt?: number
  parkRequestedBy?: string
  parkRequestedReason?: string
  parkIntent?: { token: string; by: string; at: number; pid: number }
  parkRefused?: { reason: string; at: number; by: string }
  kit?: import('../session-seat/sessionKit.js').SessionKitV1
  schedules?: import('../saturn/saturn.js').SaturnScheduleV1[]
  heldFires?: import('../saturn/saturn.js').HeldFireV1[]
  buildTree?: string
  restartReason?: 'ended' | 'update'
}

export function sessionActivityOf(
  turnActive: boolean,
  work: readonly WorkRowV1[] | undefined,
  waitingOnAgents: number,
  lastTurnAt: number | null,
): NonNullable<ConcourseWorkerRecordV1['activity']> {
  const running = (work ?? []).filter(workRowRuns)
  const subagents = running.filter(row => row.kind === 'agent').length
  const count = work === undefined ? waitingOnAgents : subagents
  const waiting = count > 0 && (!turnActive || waitingOnAgents > 0)
  const state = waiting ? 'waiting' : turnActive || running.length > 0 ? 'working' : 'idle'
  return {
    state,
    subagents: count,
    description: waiting ? `waiting on ${count} crewmate${count === 1 ? '' : 's'}` : state,
    lastTurnAt,
  }
}

export function isNewbornRecord(rec: Pick<ConcourseWorkerRecordV1, 'bornBlankAt' | 'lastDeliveryAt'>): boolean {
  return rec.bornBlankAt !== undefined && rec.lastDeliveryAt === undefined
}

export function turnInFlightOf(rec: Pick<ConcourseWorkerRecordV1, 'lastDeliveryAt' | 'lastTurnSettledAt'>): boolean {
  return rec.lastDeliveryAt !== undefined && (rec.lastTurnSettledAt === undefined || rec.lastTurnSettledAt < rec.lastDeliveryAt)
}

export function turnCutStanding(rec: Pick<ConcourseWorkerRecordV1, 'turnCutAt'>): boolean {
  return rec.turnCutAt !== undefined
}

export function stampStopped(rec: ConcourseWorkerRecordV1, by: string, retired?: ConcourseWorkerRecordV1['retired']): void {
  rec.stoppedAt = Date.now()
  rec.stoppedBy = by
  if (retired !== undefined) rec.retired = retired
  delete rec.stopRequestedAt
  delete rec.stopRequestedBy
  delete rec.stopRequestedRetired
  delete rec.parkRequestedAt
  delete rec.parkRequestedBy
  delete rec.parkRequestedReason
  delete rec.crash
}

export function stampParked(rec: ConcourseWorkerRecordV1, by: string, reason?: string): void {
  rec.parkedAt = Date.now()
  rec.parkedBy = by
  delete rec.parkRefused
  if (reason !== undefined) rec.parkReason = reason
  else delete rec.parkReason
  delete rec.parkRequestedAt
  delete rec.parkRequestedBy
  delete rec.parkRequestedReason
  delete rec.stoppedAt
  delete rec.stoppedBy
  delete rec.retired
  delete rec.turnCutAt
  delete rec.turnCutBy
  delete rec.pausedAt
  delete rec.pausedBy
  delete rec.attachRequestedAt
  delete rec.attachRequestedBy
  delete rec.crash
  delete rec.focusedAt
  delete rec.focusedBy
  delete rec.focusedAlso
  try {
    writeSessionCloseReceipts(getProjectDir(rec.workspaceId), rec.sessionId, 'park', rec.agentName)
  } catch (err) {
    console.error(`[daemon] ${rec.runnerId}: the park close receipts of session ${rec.sessionId} were not written: ${errorMessage(err)}`)
  }
}

export function clearParkedFields(rec: ConcourseWorkerRecordV1): void {
  delete rec.parkedAt
  delete rec.parkedBy
  delete rec.parkReason
  delete rec.parkRequestedAt
  delete rec.parkRequestedBy
  delete rec.parkRequestedReason
}

export function withdrawTerminalParkRequest(rec: ConcourseWorkerRecordV1): boolean {
  if (rec.parkRequestedAt === undefined || stampedTerminalPid(rec.parkRequestedBy) === undefined) return false
  delete rec.parkRequestedAt
  delete rec.parkRequestedBy
  delete rec.parkRequestedReason
  return true
}

export function terminalStampsOf(rec: { attachedBy?: string; focusedBy?: string; focusedAlso?: ReadonlyArray<{ by: string }> }): string[] {
  return [rec.attachedBy, rec.focusedBy, ...(rec.focusedAlso ?? []).map(stamp => stamp.by)].filter((stamp): stamp is string => typeof stamp === 'string' && stamp.trim() !== '')
}

export function stampedTerminalPid(by: string | undefined): number | undefined {
  const pid = /^operator:(\d+)$/.exec(by ?? '')?.[1]
  return pid === undefined ? undefined : Number(pid)
}
