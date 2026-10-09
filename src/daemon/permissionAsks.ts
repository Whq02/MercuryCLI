import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { daemonHomeStands, publishInDaemonHome } from './daemonHome.js'
import { join } from 'node:path'
import { logForDebugging } from '../utils/debug.js'
import { noteSessionAsking } from './sessionStateHooks.js'
import { armInactivityDeadline, formatLimit, type InactivityDeadline } from '../utils/deadline.js'
import { askExpiredCause, askLimitMs, isAskExpiredCause, unansweredAskRefusal } from '../utils/permissions/askClock.js'
import { askBoardQuestion } from '../utils/permissions/askWords.js'
import { recordSettledObligation, upsertObligation } from '../services/crew/obligations.js'
import {
  publishSessionAsks,
  type SessionAskProjectionV1,
} from '../services/engine-connector/seatProjections.js'
import type { PermissionUpdate } from '../types/permissions.js'
import type { PermissionAnswer, PermissionRequestParams } from '../runner/wire/methods.js'
import { SANDBOX_NETWORK_ACCESS_TOOL_NAME } from './runnerFrames.js'
import type { HeldAsk } from './runnerConnection.js'
import {
  DENIAL_WORKAROUND_GUIDANCE,
  REJECT_MESSAGE,
  REJECT_MESSAGE_WITH_REASON_PREFIX,
  UNANSWERED_ASK_REJECT_MESSAGE,
} from '../utils/messages/rejectionText.js'
import {
  decodeDecisionReasonFromWire,
  type DecisionReasonWireV1,
} from '../utils/permissions/decisionReasonWire.js'
import { clientPresenceVerdict } from './clientPresence.js'
import { daemonDir, daemonStatePath } from './controlSocket.js'
import { nextLiveCockpitOwner, readSessionWorkers } from './concourseWorkers.js'
import { initGitRepository } from './concourseWorktrees.js'
import { isProcessAlive } from './ownerWatch.js'
import { countEntriesBounded, entryCountWords, gitInitRefusal, type GitInitRefusal } from '../utils/projectBoundary.js'

function gitInitAsksPath(): string {
  return join(daemonDir(), 'git-init-asks.json')
}

function readGitInitAsks(): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(gitInitAsksPath(), 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string' && k.startsWith('git-init:')) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function writeGitInitAsks(map: Record<string, string>): void {
  try {
    if (!daemonHomeStands('the git-init asks')) return
    publishInDaemonHome('the git-init asks', gitInitAsksPath(), JSON.stringify(map))
  } catch (err) {
    logForDebugging(`[daemon] git-init ask sidecar write failed: ${err}`)
  }
}

function findGitInitFolderByRef(requestId: string): string | undefined {
  return readGitInitAsks()[requestId]
}

export function expiredAskDenialMessage(toolName: string, limitMs: number, cause: 'expired' | 'evicted'): string {
  if (cause === 'expired') return unansweredAskRefusal(toolName, limitMs)
  return `Permission to use ${toolName} has been denied: the permission ask was dropped unanswered because the switchboard's parked-ask table was full. ${DENIAL_WORKAROUND_GUIDANCE}`
}

export const NO_CLIENT_ATTACHED_CAUSE = 'no operator client is attached to the switchboard'

export type OperatorClientPresence = 'attached' | 'absent' | 'unknown'

export function operatorClientPresence(dir?: string, now: number = Date.now()): OperatorClientPresence {
  const beat = clientPresenceVerdict(now)
  if (beat === 'attached') return 'attached'
  let record: { ownerPid?: unknown } | null
  try {
    record = JSON.parse(readFileSync(daemonStatePath(), 'utf8')) as { ownerPid?: unknown } | null
  } catch {
    return 'unknown'
  }
  if (record === null || typeof record !== 'object') return 'unknown'
  if (typeof record.ownerPid === 'number' && isProcessAlive(record.ownerPid)) return 'attached'
  if (nextLiveCockpitOwner(null, dir) !== undefined) return 'attached'
  return beat
}

export function unattendedAskDenialMessage(toolName: string): string {
  return UNANSWERED_ASK_REJECT_MESSAGE(toolName, NO_CLIENT_ATTACHED_CAUSE)
}

interface PendingAsk {
  workerId: string
  sessionId: string
  workspaceId: string
  toolName: string
  input: Record<string, unknown>
  toolUseId?: string
  agentId?: string
  suggestions?: PermissionUpdate[]
  blockedPath?: string
  decisionReason?: string
  decisionReasonDetail?: DecisionReasonWireV1
  description?: string
  obligationId?: string
  obligationLanded?: Promise<string | undefined>
  askedAt?: number
  limitMs?: number
  deadline?: InactivityDeadline
  settle?: (answer: PermissionAnswer) => void
  local?: 'git-init'
}

const pending = new Map<string, PendingAsk>()
const retired = new Map<string, string>()
const MAX_RETIRED = 200

export const RUNNER_RESTARTED_ASK_CAUSE = "the session's runner restarted before this ask was answered — nothing was run"
export const RUNNER_ENDED_ASK_CAUSE = "the session's runner ended before this ask was answered — nothing was run"

function rememberRetired(requestId: string, cause: string): void {
  retired.delete(requestId)
  retired.set(requestId, cause)
  while (retired.size > MAX_RETIRED) {
    const oldest = retired.keys().next().value
    if (oldest === undefined) break
    retired.delete(oldest)
  }
}

export function retireWorkerAsks(short: string, cause: string, dir?: string): string[] {
  const retiredIds: string[] = []
  const sessions = new Set<string>()
  for (const [requestId, ask] of pending) {
    if (ask.local !== undefined || ask.workerId !== short) continue
    pending.delete(requestId)
    ask.deadline?.cancel()
    rememberRetired(requestId, cause)
    retiredIds.push(requestId)
    sessions.add(ask.sessionId)
    // eslint-disable-next-line no-console
    console.error(`[daemon] permission ask ${requestId} (${ask.toolName} for ${short}) withdrawn — ${cause}`)
    settleAskObligation(ask, { kind: 'withdrawn', by: `daemon: ${cause}` })
  }
  for (const sessionId of sessions) publishAsksFor(sessionId, dir)
  return retiredIds
}

function settleAskObligation(ask: PendingAsk, outcome: { kind: 'withdrawn' | 'answered'; by: string }): void {
  const landed = ask.obligationLanded ?? Promise.resolve(ask.obligationId)
  void landed
    .then(async obligationId => {
      if (obligationId === undefined) return
      const o = await import('../services/crew/obligations.js')
      await o.resolveObligation(obligationId, { ...outcome, scope: 'switchboard' } as Parameters<typeof o.resolveObligation>[1])
    })
    .catch(() => {})
}
const MAX_PENDING = 200

function publishAsksFor(sessionId: string, dir?: string): void {
  if (sessionId.startsWith('folder:')) return
  const asks: SessionAskProjectionV1[] = []
  for (const [requestId, a] of pending) {
    if (a.local !== undefined || a.sessionId !== sessionId) continue
    asks.push({
      requestId,
      toolUseId: a.toolUseId ?? requestId,
      toolName: a.toolName,
      input: a.input,
      ...(a.suggestions !== undefined ? { suggestions: a.suggestions } : {}),
      ...(a.blockedPath !== undefined ? { blockedPath: a.blockedPath } : {}),
      ...(a.decisionReason !== undefined ? { decisionReason: a.decisionReason } : {}),
      ...(a.decisionReasonDetail !== undefined ? { decisionReasonDetail: a.decisionReasonDetail } : {}),
      ...(a.description !== undefined ? { description: a.description } : {}),
      ...(a.agentId !== undefined ? { agentId: a.agentId } : {}),
      askedAt: a.askedAt ?? Date.now(),
      ...(a.agentId !== undefined && a.limitMs !== undefined && a.limitMs > 0 ? { limitMs: a.limitMs } : {}),
    })
  }
  try {
    publishSessionAsks({ schema: 1, sessionId, asks }, dir)
  } catch (err) {
    logForDebugging(`[daemon] session asks publish failed for ${sessionId}: ${err}`)
  }
  noteSessionAsking(sessionId, asks.length > 0, readSessionWorkers(dir))
}

export interface SeatAskAnswerV1 {
  updatedInput?: Record<string, unknown>
  permissionUpdates?: PermissionUpdate[]
  feedback?: string
  interrupt?: boolean
}

function settleUnanswered(
  requestId: string,
  ask: PendingAsk,
  cause: 'expired' | 'evicted',
  limitMs: number,
): void {
  pending.delete(requestId)
  ask.deadline?.cancel()
  publishAsksFor(ask.sessionId)
  ask.settle?.({ outcome: 'deny', message: expiredAskDenialMessage(ask.toolName, limitMs, cause) })
  const waited = ask.askedAt !== undefined ? formatLimit(Date.now() - ask.askedAt) : 'an unknown time'
  // eslint-disable-next-line no-console
  console.error(`[daemon] permission ask ${requestId} (${ask.toolName} for ${ask.workerId}) ${cause} after ${waited} — the runner was told`)
  settleAskObligation(ask, {
    kind: 'withdrawn',
    by: cause === 'expired' ? `daemon: ${askExpiredCause(limitMs)}` : 'daemon: dropped unanswered (parked-ask table full)',
  })
}

function denyUnattended(
  requestId: string,
  short: string,
  rec: { sessionId: string; workspaceId: string; title?: string },
  toolName: string,
): PermissionAnswer {
  // eslint-disable-next-line no-console
  console.error(`[daemon] permission ask ${requestId} (${toolName} for ${short}) denied at once — ${NO_CLIENT_ATTACHED_CAUSE}`)
  void recordSettledObligation({
    ref: `permission:${requestId}`,
    sessionId: rec.sessionId,
    question: `"${rec.title ?? short}" asked to run ${toolName} — denied at once: ${NO_CLIENT_ATTACHED_CAUSE}`,
    owner: 'operator',
    scope: 'switchboard',
    settlement: { kind: 'withdrawn', by: `daemon: denied at once — ${NO_CLIENT_ATTACHED_CAUSE}` },
  }).catch(err => {
    logForDebugging(`[daemon] unattended-ask receipt write failed: ${err}`)
  })
  return { outcome: 'deny', message: unattendedAskDenialMessage(toolName) }
}

const NO_SEAT_OWNER_CAUSE = 'no operator holds this seat'

const answered = (answer: PermissionAnswer): HeldAsk => ({ answer: Promise.resolve(answer), withdraw: () => {} })

export function holdWorkerAsk(
  short: string,
  params: PermissionRequestParams,
  dir?: string,
  expiryMs?: number,
  presence: (dir?: string) => OperatorClientPresence = operatorClientPresence,
): HeldAsk {
  const toolName = params.kind === 'tool' ? params.tool_name : SANDBOX_NETWORK_ACCESS_TOOL_NAME
  if (!short.startsWith('concourse-w')) {
    // eslint-disable-next-line no-console
    console.error(`[daemon] permission ask (${toolName} for ${short}) denied at once — ${NO_SEAT_OWNER_CAUSE}`)
    return answered({ outcome: 'deny', message: UNANSWERED_ASK_REJECT_MESSAGE(toolName, NO_SEAT_OWNER_CAUSE) })
  }
  const rec = readSessionWorkers(dir)[short]
  if (!rec || rec.endedAt !== undefined) {
    return answered({ outcome: 'deny', message: UNANSWERED_ASK_REJECT_MESSAGE(toolName, 'the session this seat served has ended') })
  }
  const requestId = randomUUID()
  if (presence(dir) === 'absent') return answered(denyUnattended(requestId, short, rec, toolName))
  if (pending.size >= MAX_PENDING) {
    for (const [oldestId, oldest] of pending) {
      if (oldest.local !== undefined) continue
      settleUnanswered(oldestId, oldest, 'evicted', oldest.limitMs ?? 0)
      break
    }
  }
  const askMode = params.kind === 'tool' && params.mode !== undefined ? params.mode : rec.permissionMode
  const limitMs = expiryMs ?? askLimitMs({ mode: askMode, crewmate: true })
  const input = params.kind === 'tool' ? params.input : { host: params.host }
  const suggestions = params.kind === 'tool' ? (params.suggestions as PermissionUpdate[] | undefined) : undefined
  const ask: PendingAsk = {
    workerId: short,
    sessionId: rec.sessionId,
    workspaceId: rec.workspaceId,
    toolName,
    input,
    ...(params.kind === 'tool' ? { toolUseId: params.tool_use_id } : {}),
    ...(params.kind === 'tool' && params.agent_id !== undefined && params.agent_id !== '' ? { agentId: params.agent_id } : {}),
    ...(suggestions !== undefined && suggestions.length > 0 ? { suggestions } : {}),
    ...(params.kind === 'tool' && params.blocked_path !== undefined ? { blockedPath: params.blocked_path } : {}),
    ...(params.kind === 'tool' && params.reason !== undefined ? { decisionReason: params.reason } : {}),
    ...(params.kind === 'tool' && decodeDecisionReasonFromWire(params.reason_detail) !== undefined
      ? { decisionReasonDetail: params.reason_detail as DecisionReasonWireV1 }
      : {}),
    ...(params.kind === 'tool' && params.description !== undefined ? { description: params.description } : {}),
    ...(params.kind === 'network' ? { description: `Allow network access to ${params.host}?` } : {}),
    askedAt: Date.now(),
    limitMs,
  }
  const answer = new Promise<PermissionAnswer>(resolve => {
    ask.settle = resolve
  })
  pending.set(requestId, ask)
  publishAsksFor(rec.sessionId, dir)
  if (ask.agentId !== undefined) {
    ask.deadline = armInactivityDeadline({
      seam: `permission ask ${requestId} (${toolName} for ${short})`,
      limitMs,
      onExpire: () => {
        if (pending.get(requestId) !== ask) return
        settleUnanswered(requestId, ask, 'expired', limitMs)
      },
    })
  }
  ask.obligationLanded = upsertObligation({
    ref: `permission:${requestId}`,
    sessionId: rec.sessionId,
    question: askBoardQuestion(rec.title ?? short, toolName),
    owner: 'operator',
    scope: 'switchboard',
  })
    .then(res => {
      ask.obligationId = res.obligationId
      return res.obligationId
    })
    .catch(err => {
      logForDebugging(`[daemon] permission-ask obligation write failed: ${err}`)
      return undefined
    })
  return { answer, withdraw: cause => onWorkerAskWithdrawn(requestId, dir, cause) }
}

export function mintGitInitAsk(folder: string): { requestId: string } | { refused: GitInitRefusal } {
  const refusal = gitInitRefusal(folder)
  if (refusal !== null) {
    logForDebugging(`[daemon] git-init ask not minted for ${folder}: ${refusal.words}`)
    return { refused: refusal }
  }
  for (const [id, a] of pending) {
    if (a.local === 'git-init' && a.workspaceId === folder) return { requestId: id }
  }
  const requestId = `git-init:${createHash('sha1').update(folder).digest('hex').slice(0, 12)}`
  writeGitInitAsks({ ...readGitInitAsks(), [requestId]: folder })
  if (pending.size >= MAX_PENDING) {
    for (const [oldestId, oldest] of pending) {
      if (oldest.local !== undefined) continue
      settleUnanswered(oldestId, oldest, 'evicted', oldest.limitMs ?? 0)
      break
    }
  }
  const ask: PendingAsk = {
    workerId: '',
    sessionId: `folder:${folder}`,
    workspaceId: folder,
    toolName: 'git init',
    input: {},
    local: 'git-init',
  }
  pending.set(requestId, ask)
  const entries = entryCountWords(countEntriesBounded(folder))
  ask.obligationLanded = upsertObligation({
    ref: `permission:${requestId}`,
    sessionId: ask.sessionId,
    question: `this folder has no git — start one in ${folder} (${entries}) so sessions can fork it?`,
    owner: 'operator',
    scope: 'switchboard',
  })
    .then(res => {
      ask.obligationId = res.obligationId
      return res.obligationId
    })
    .catch(err => {
      logForDebugging(`[daemon] git-init ask obligation write failed: ${err}`)
      return undefined
    })
  return { requestId }
}

export function mintGitRefusedReceipt(clientMessageId: string, folder: string, refusal: GitInitRefusal): void {
  void upsertObligation({
    ref: `git-refused:${clientMessageId}`,
    sessionId: `dispatch:${clientMessageId}`,
    question: `no git offer for ${folder} — ${refusal.words} · kept without git: the launch waits until the folder frees`,
    owner: 'operator',
    scope: 'switchboard',
  }).catch(err => logForDebugging(`[daemon] git-refused receipt write failed: ${err}`))
}

export function onWorkerAskWithdrawn(requestId: string, dir?: string, cause?: string): void {
  const ask = pending.get(requestId)
  if (!ask || ask.local !== undefined) return
  pending.delete(requestId)
  ask.deadline?.cancel()
  publishAsksFor(ask.sessionId, dir)
  const expired = cause !== undefined && isAskExpiredCause(cause)
  if (expired) {
    const waited = ask.askedAt !== undefined ? formatLimit(Date.now() - ask.askedAt) : 'an unknown time'
    // eslint-disable-next-line no-console
    console.error(`[daemon] permission ask ${requestId} (${ask.toolName} for ${ask.workerId}) ${cause} (after ${waited}) — the runner refused it`)
  }
  settleAskObligation(ask, { kind: 'withdrawn', by: expired ? `the session: ${cause}` : 'daemon: the session moved on (its ask was cancelled)' })
}

export function answerPermissionAsk(
  requestId: string,
  allow: boolean,
  by: string,
  hooks?: {
    onGitReady?: (folder: string) => ReadonlyArray<{ clientMessageId: string; title?: string }>
    onDenyProceed?: (folder: string) => ReadonlyArray<{ clientMessageId: string; title?: string }>
  },
  answer?: SeatAskAnswerV1,
): { outcome: 'applied' | 'refused'; detail?: string } {
  let ask = pending.get(requestId)
  if (!ask && requestId.startsWith('git-init:')) {
    const folder = findGitInitFolderByRef(requestId)
    if (folder !== undefined) {
      ask = {
        workerId: '',
        sessionId: `folder:${folder}`,
        workspaceId: folder,
        toolName: 'git init',
        input: {},
        local: 'git-init',
      }
      pending.set(requestId, ask)
    }
  }
  if (!ask) return { outcome: 'refused', detail: retired.get(requestId) ?? 'unknown or already-answered permission request' }
  if (ask.local === 'git-init') {
    const settleObligation = (): void => settleAskObligation(ask, { kind: 'answered', by })
    const dropSidecar = (): void => {
      const map = readGitInitAsks()
      if (map[requestId] !== undefined) {
        delete map[requestId]
        writeGitInitAsks(map)
      }
    }
    if (!allow) {
      pending.delete(requestId)
      dropSidecar()
      settleObligation()
      const starting = hooks?.onDenyProceed?.(ask.workspaceId) ?? []
      const names = starting
        .map(s => s.title ?? s.clientMessageId)
        .filter(n => n.length > 0)
        .slice(0, 4)
      return {
        outcome: 'applied',
        detail:
          names.length > 0
            ? `kept without git — starting in the folder as it is, alone: ${names.join(', ')}`
            : 'kept without git — the launch stays queued until the folder frees or git lands',
      }
    }
    const r = initGitRepository(ask.workspaceId)
    pending.delete(requestId)
    dropSidecar()
    settleObligation()
    if (!r.ok) return { outcome: 'refused', detail: r.error ?? 'git init failed' }
    const starting = hooks?.onGitReady?.(ask.workspaceId) ?? []
    const names = starting
      .map(s => s.title ?? s.clientMessageId)
      .filter(n => n.length > 0)
      .slice(0, 4)
    return {
      outcome: 'applied',
      detail:
        names.length > 0
          ? `git ready in ${ask.workspaceId} — starting: ${names.join(', ')}`
          : `git ready in ${ask.workspaceId} — the queued launch starts on its own`,
    }
  }
  const updatedInput = answer?.updatedInput
  const updatedPermissions = answer?.permissionUpdates !== undefined && answer.permissionUpdates.length > 0 ? answer.permissionUpdates : undefined
  const feedback = answer?.feedback?.trim()
  const denial = feedback ? REJECT_MESSAGE_WITH_REASON_PREFIX + feedback : REJECT_MESSAGE
  if (ask.settle === undefined) return { outcome: 'refused', detail: 'the ask has no runner to answer' }
  pending.delete(requestId)
  ask.deadline?.cancel()
  ask.settle(
    allow
      ? { outcome: 'allow', ...(updatedInput !== undefined ? { input: updatedInput } : {}), ...(updatedPermissions !== undefined ? { rules: updatedPermissions as never } : {}) }
      : { outcome: 'deny', message: denial, ...(answer?.interrupt === true ? { stop: true } : {}) },
  )
  publishAsksFor(ask.sessionId)
  settleAskObligation(ask, { kind: 'answered', by })
  return {
    outcome: 'applied',
    detail: `${allow ? 'allowed' : 'denied'} ${ask.toolName} for ${ask.workerId}`,
  }
}

export function listPendingPermissionAsks(): ReadonlyArray<{
  requestId: string
  workerId: string
  sessionId: string
  toolName: string
  agentId?: string
  askedAt?: number
  limitMs?: number
}> {
  return [...pending.entries()].map(([requestId, a]) => ({
    requestId,
    workerId: a.workerId,
    sessionId: a.sessionId,
    toolName: a.toolName,
    ...(a.agentId !== undefined ? { agentId: a.agentId } : {}),
    ...(a.askedAt !== undefined ? { askedAt: a.askedAt } : {}),
    ...(a.limitMs !== undefined ? { limitMs: a.limitMs } : {}),
  }))
}
