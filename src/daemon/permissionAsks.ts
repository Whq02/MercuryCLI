import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { logForDebugging } from '../utils/debug.js'
import { armInactivityDeadline, formatLimit, minutesKnobToMs, type InactivityDeadline } from '../utils/deadline.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { upsertObligation } from '../services/crew/obligations.js'
import {
  publishSessionAsks,
  type SessionAskProjectionV1,
} from '../services/engine-connector/seatProjections.js'
import type { PermissionUpdate } from '../types/permissions.js'
import {
  DENIAL_WORKAROUND_GUIDANCE,
  REJECT_MESSAGE,
  REJECT_MESSAGE_WITH_REASON_PREFIX,
} from '../utils/messages/rejectionText.js'
import {
  decodeDecisionReasonFromWire,
  type DecisionReasonWireV1,
} from '../utils/permissions/decisionReasonWire.js'
import { daemonDir } from './controlSocket.js'
import { readSessionWorkers } from './concourseSupervisor.js'
import { initGitRepository } from './concourseWorktrees.js'
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
    const path = gitInitAsksPath()
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(map), 'utf8')
    renameSync(tmp, path)
  } catch (err) {
    logForDebugging(`[daemon] git-init ask sidecar write failed: ${err}`)
  }
}

function findGitInitFolderByRef(requestId: string): string | undefined {
  return readGitInitAsks()[requestId]
}

export const DEFAULT_PERMISSION_ASK_EXPIRY_MINUTES = 30

export function permissionAskExpiryMs(): number {
  return minutesKnobToMs(flagEnv('MERCURY_PERMISSION_ASK_EXPIRY_MINUTES'), DEFAULT_PERMISSION_ASK_EXPIRY_MINUTES)
}

export interface AskControlChannel {
  control(short: string, frame: string): boolean
}

export function expiredAskDenialMessage(toolName: string, limitMs: number, cause: 'expired' | 'evicted'): string {
  const what =
    cause === 'expired'
      ? `nobody answered the permission ask within ${formatLimit(limitMs)}, so it expired`
      : `the permission ask was dropped unanswered because the switchboard's parked-ask table was full`
  return `Permission to use ${toolName} has been denied: ${what}. ${DENIAL_WORKAROUND_GUIDANCE}`
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
  deadline?: InactivityDeadline
  channel?: AskControlChannel
  local?: 'git-init'
}

const pending = new Map<string, PendingAsk>()

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
      askedAt: a.askedAt ?? Date.now(),
    })
  }
  try {
    publishSessionAsks({ schema: 1, sessionId, asks }, dir)
  } catch (err) {
    logForDebugging(`[daemon] session asks publish failed for ${sessionId}: ${err}`)
  }
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
  channel: AskControlChannel | undefined,
  limitMs: number,
): void {
  pending.delete(requestId)
  ask.deadline?.cancel()
  publishAsksFor(ask.sessionId)
  const frame = JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: { behavior: 'deny', message: expiredAskDenialMessage(ask.toolName, limitMs, cause) },
    },
  })
  const routed = channel ?? ask.channel
  const delivered = routed !== undefined && routed.control(ask.workerId, frame)
  const waited = ask.askedAt !== undefined ? formatLimit(Date.now() - ask.askedAt) : 'an unknown time'
  // eslint-disable-next-line no-console
  console.error(
    `[daemon] permission ask ${requestId} (${ask.toolName} for ${ask.workerId}) ${cause} after ${waited}${delivered ? ' — the child was told' : ' — no live control channel to tell'}`,
  )
  settleAskObligation(ask, {
    kind: 'withdrawn',
    by: cause === 'expired' ? `daemon: expired unanswered after ${formatLimit(limitMs)}` : 'daemon: dropped unanswered (parked-ask table full)',
  })
}

export function onWorkerControlRequest(
  short: string,
  frame: Record<string, unknown>,
  dir?: string,
  channel?: AskControlChannel,
  expiryMs: number = permissionAskExpiryMs(),
): void {
  if (!short.startsWith('concourse-w')) return
  const request = frame.request as Record<string, unknown> | undefined
  if (!request || request.subtype !== 'can_use_tool') return
  const requestId = String(frame.request_id ?? '')
  if (!requestId || pending.has(requestId)) return
  const rec = readSessionWorkers(dir)[short]
  if (!rec || rec.endedAt !== undefined) return
  const toolName = String(request.tool_name ?? 'a tool')
  const input = (request.input ?? {}) as Record<string, unknown>
  if (pending.size >= MAX_PENDING) {
    for (const [oldestId, oldest] of pending) {
      if (oldest.local !== undefined) continue
      settleUnanswered(oldestId, oldest, 'evicted', channel, expiryMs)
      break
    }
  }
  const suggestions = Array.isArray(request.permission_suggestions)
    ? (request.permission_suggestions as PermissionUpdate[])
    : undefined
  const ask: PendingAsk = {
    workerId: short,
    sessionId: rec.sessionId,
    workspaceId: rec.workspaceId,
    toolName,
    input,
    ...(typeof request.tool_use_id === 'string' ? { toolUseId: request.tool_use_id } : {}),
    ...(typeof request.agent_id === 'string' && request.agent_id !== '' ? { agentId: request.agent_id } : {}),
    ...(suggestions !== undefined && suggestions.length > 0 ? { suggestions } : {}),
    ...(typeof request.blocked_path === 'string' ? { blockedPath: request.blocked_path } : {}),
    ...(typeof request.decision_reason === 'string' ? { decisionReason: request.decision_reason } : {}),
    ...(decodeDecisionReasonFromWire(request.decision_reason_detail) !== undefined
      ? { decisionReasonDetail: request.decision_reason_detail as DecisionReasonWireV1 }
      : {}),
    ...(typeof request.description === 'string' ? { description: request.description } : {}),
    askedAt: Date.now(),
    ...(channel !== undefined ? { channel } : {}),
  }
  pending.set(requestId, ask)
  publishAsksFor(rec.sessionId, dir)
  ask.deadline = armInactivityDeadline({
    seam: `permission ask ${requestId} (${toolName} for ${short})`,
    limitMs: expiryMs,
    onExpire: () => {
      if (pending.get(requestId) !== ask) return
      settleUnanswered(requestId, ask, 'expired', channel, expiryMs)
    },
  })
  ask.obligationLanded = upsertObligation({
    ref: `permission:${requestId}`,
    sessionId: rec.sessionId,
    question: `"${rec.title ?? short}" asks to run ${toolName} — allow?`,
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
      settleUnanswered(oldestId, oldest, 'evicted', undefined, permissionAskExpiryMs())
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

export function onWorkerControlCancel(requestId: string, dir?: string): void {
  const ask = pending.get(requestId)
  if (!ask || ask.local !== undefined) return
  pending.delete(requestId)
  ask.deadline?.cancel()
  publishAsksFor(ask.sessionId, dir)
  settleAskObligation(ask, { kind: 'withdrawn', by: 'daemon: the session moved on (its ask was cancelled)' })
}

export function answerPermissionAsk(
  requestId: string,
  allow: boolean,
  roster: { control(short: string, frame: string): boolean } | undefined,
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
  if (!ask) return { outcome: 'refused', detail: 'unknown or already-answered permission request' }
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
  const updatedInput =
    answer?.updatedInput !== undefined && Object.keys(answer.updatedInput).length > 0 ? answer.updatedInput : ask.input
  const updatedPermissions = answer?.permissionUpdates !== undefined && answer.permissionUpdates.length > 0 ? answer.permissionUpdates : undefined
  const feedback = answer?.feedback?.trim()
  const denial = feedback ? REJECT_MESSAGE_WITH_REASON_PREFIX + feedback : REJECT_MESSAGE
  const frame = JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: allow
        ? { behavior: 'allow', updatedInput, ...(updatedPermissions !== undefined ? { updatedPermissions } : {}) }
        : { behavior: 'deny', message: denial, ...(answer?.interrupt === true ? { interrupt: true } : {}) },
    },
  })
  const delivered = roster !== undefined && roster.control(ask.workerId, frame)
  if (!delivered) return { outcome: 'refused', detail: 'worker has no live control channel' }
  pending.delete(requestId)
  ask.deadline?.cancel()
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
}> {
  return [...pending.entries()].map(([requestId, a]) => ({
    requestId,
    workerId: a.workerId,
    sessionId: a.sessionId,
    toolName: a.toolName,
    ...(a.agentId !== undefined ? { agentId: a.agentId } : {}),
    ...(a.askedAt !== undefined ? { askedAt: a.askedAt } : {}),
  }))
}
