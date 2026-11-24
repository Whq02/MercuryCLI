import { rewindOutcomeFromWire } from '../../engine/connector/seatWire.js'
import type { ParamsOf, ResultOf } from '../runner-wire/methods.js'
import { SESSION_VERBS, type RunnerVerbKey, type SessionVerbRow } from '../runner-wire/sessionVerbs.js'
import type { Verb } from '../runner-link/runnerConnection.js'
import type { QuiescenceRequest, QuiescenceAnswer } from '../runner-link/runnerQuiescence.js'
import type { SessionRewindMode, SessionRewindOutcomeV1, BoardPostRequestV1, McpToolsV1 } from '../control/protocol.js'
import { mcpToolsFromWire } from '../../integrations/mcp/toolsAnswer.js'
import { liveRecordBySession, seatBusy, type SeatRosterPort } from './state.js'
import { askSeat, runnerAnswered, NO_DOOR_DETAIL, type DoorFailure, type SeatVerbOutcome } from './door.js'
import { requestSessionFacts } from './facts.js'

type HostRequestVerbKey = {
  [K in RunnerVerbKey]: (typeof SESSION_VERBS)[K]['runner'] extends { readonly name: Verb; readonly from: 'host'; readonly kind: 'request' } ? K : never
}[RunnerVerbKey]

type RunnerMethodOf<K extends HostRequestVerbKey> = (typeof SESSION_VERBS)[K]['runner']['name']

const UNKNOWN_SESSION_REFUSAL: SeatVerbOutcome = {
  outcome: 'refused',
  detail: 'unknown-session: no live worker record owns this session',
}

interface SeatVerbPolicy<K extends HostRequestVerbKey, Out extends SeatVerbOutcome = SeatVerbOutcome> {
  readonly verb: K
  readonly label?: string
  readonly deadlineMs?: number
  readonly refreshFacts?: 'answered' | 'none'
  readonly olderDetail?: string
  readonly validate?: (runnerId: string) => SeatVerbOutcome | undefined
  readonly onAnswer: (result: ResultOf<RunnerMethodOf<K>>, runnerId: string) => Out
  readonly onFailure?: (failure: DoorFailure, id: number | null) => SeatVerbOutcome
}

export const REWIND_ANSWER_DEADLINE_MS = SESSION_VERBS.rewind.runner.deadlineMs

function refusedRewind(mode: SessionRewindMode, refusal: NonNullable<SessionRewindOutcomeV1['refusal']>, detail: string): SessionRewindOutcomeV1 {
  return { outcome: 'refused', mode, refusal, detail }
}

export async function rewindSession(
  sessionId: string,
  req: { mode: SessionRewindMode; userMessageId: string; dryRun?: boolean },
  roster: SeatRosterPort,
  dir?: string,
  opts?: { deadlineMs?: number; fileRestore?: import('../control/protocol.js').SessionFileRestoreRequest },
): Promise<SessionRewindOutcomeV1> {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return refusedRewind(req.mode, 'unknown-session', 'no live worker record owns this session')
  if (seatBusy(rec.runnerId, roster)) {
    return refusedRewind(req.mode, 'turn-active', 'a turn is running in this session — press esc to stop it, then /rewind again')
  }
  const deadlineMs = opts?.deadlineMs ?? REWIND_ANSWER_DEADLINE_MS
  const fileRestore = opts?.fileRestore
  const asked = fileRestore === undefined
    ? await askSeat(roster, rec.runnerId, SESSION_VERBS.rewind.runner.name, { user_message_id: req.userMessageId, mode: req.mode, ...(req.dryRun === true ? { dry_run: true } : {}) }, 'rewind', deadlineMs)
    : await askSeat(roster, rec.runnerId, SESSION_VERBS.fileRestore.runner.name, {
        user_message_id: fileRestore.userMessageId,
        ...(fileRestore.action === 'restore' ? { action: 'restore', file_path: fileRestore.filePath } : { action: 'undo' }),
        ...(fileRestore.dryRun === true ? { dry_run: true } : {}),
      }, 'rewind', deadlineMs)
  if (runnerAnswered(asked)) requestSessionFacts(rec.runnerId, roster, { immediate: true }, dir)
  if (asked.ok) {
    const outcome = rewindOutcomeFromWire(asked.result)
    return outcome ?? refusedRewind(req.mode, 'restore-failed', 'the runner answered the rewind with a receipt the seat cannot read')
  }
  const { failure } = asked
  if (failure.kind === 'left' && asked.id === null) return refusedRewind(req.mode, 'no-channel', failure.words)
  if (failure.kind === 'left' || failure.kind === 'silent') return refusedRewind(req.mode, 'no-answer', `${failure.words} — nothing is assumed restored`)
  if (failure.kind === 'older') return refusedRewind(req.mode, 'runner-older', "the session's runner predates the rewind verb — /daemon restart when ready, then reopen the session")
  return refusedRewind(req.mode, 'restore-failed', failure.words)
}

export const CREWMATE_VERB_ANSWER_DEADLINE_MS = SESSION_VERBS.stopAgent.runner.deadlineMs

export type SessionCrewmateVerb = typeof SESSION_VERBS.stopAgent.daemon.action | typeof SESSION_VERBS.resumeAgent.daemon.action

function crewVerbRefusal(failure: DoorFailure, older: string): SeatVerbOutcome {
  if (failure.kind === 'older') return { outcome: 'refused', detail: older }
  if (failure.kind === 'left' && failure.words === NO_DOOR_DETAIL) return { outcome: 'refused', detail: failure.words }
  if (failure.kind === 'left') return { outcome: 'refused', detail: `${failure.words} — nothing is assumed done` }
  return { outcome: 'refused', detail: failure.words }
}

function appliedDetail(result: unknown): SeatVerbOutcome {
  const payload = result !== null && typeof result === 'object' ? (result as Record<string, unknown>) : {}
  const detail = Object.keys(payload).length > 0 ? JSON.stringify(payload) : undefined
  return { outcome: 'applied', ...(detail !== undefined ? { detail } : {}) }
}

async function runSeatVerb<K extends HostRequestVerbKey, Out extends SeatVerbOutcome = SeatVerbOutcome>(
  sessionId: string,
  params: ParamsOf<RunnerMethodOf<K>>,
  roster: SeatRosterPort,
  dir: string | undefined,
  policy: SeatVerbPolicy<K, Out>,
): Promise<Out | SeatVerbOutcome> {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return UNKNOWN_SESSION_REFUSAL
  const blocked = policy.validate?.(rec.runnerId)
  if (blocked !== undefined) return blocked
  const row = SESSION_VERBS[policy.verb]
  const label = policy.label ?? ('daemon' in row && 'action' in row.daemon ? row.daemon.action : row.runner.name)
  const deadlineMs = policy.deadlineMs ?? row.runner.deadlineMs ?? CREWMATE_VERB_ANSWER_DEADLINE_MS
  const asked = await askSeat<RunnerMethodOf<K>>(roster, rec.runnerId, row.runner.name as RunnerMethodOf<K>, params, label, deadlineMs)
  if (policy.refreshFacts !== 'none' && runnerAnswered(asked)) {
    requestSessionFacts(rec.runnerId, roster, { immediate: true }, dir)
  }
  if (asked.ok) return policy.onAnswer(asked.result as ResultOf<RunnerMethodOf<K>>, rec.runnerId)
  if (policy.onFailure !== undefined) return policy.onFailure(asked.failure, asked.id)
  return crewVerbRefusal(asked.failure, policy.olderDetail ?? asked.failure.words)
}

export async function controlSessionCrewmate(
  sessionId: string,
  agentId: string,
  verb: SessionCrewmateVerb,
  roster: SeatRosterPort,
  dir?: string,
  opts?: { note?: string; deadlineMs?: number },
): Promise<SeatVerbOutcome> {
  const params = { agent_id: agentId, ...(opts?.note !== undefined ? { note: opts.note } : {}) }
  return runSeatVerb(sessionId, params, roster, dir, {
    verb: verb === SESSION_VERBS.stopAgent.daemon.action ? 'stopAgent' : 'resumeAgent',
    label: verb,
    deadlineMs: opts?.deadlineMs ?? CREWMATE_VERB_ANSWER_DEADLINE_MS,
    validate: () => (agentId === '' ? { outcome: 'refused', detail: `${verb} requires agentId` } : undefined),
    onAnswer: (result, runnerId) => {
      console.error(`[daemon] seat ${verb} applied: ${runnerId} → ${agentId}`)
      return appliedDetail(result)
    },
    olderDetail: "the session's runner predates the crew stop and resume verbs — /daemon restart when ready, then reopen the session",
  })
}

type EmptyDetailSeatVerbKey = {
  [K in HostRequestVerbKey]: (typeof SESSION_VERBS)[K] extends { readonly carrier: 'empty-detail' } ? K : never
}[HostRequestVerbKey]

interface GenericZeroArgSeatVerb {
  readonly key: EmptyDetailSeatVerbKey
  readonly action: string
  readonly olderDetail: string
}

const EMPTY_DETAIL_OLDER_DETAIL: Readonly<Record<string, string>> = {
  [SESSION_VERBS.backgroundShell.daemon.action]: "this session's runner predates shift+B · /daemon restart, then reopen the session",
  [SESSION_VERBS.sendNow.daemon.action]: "this session's runner predates ctrl+s s · /daemon restart, then reopen the session",
}

const GENERIC_ZERO_ARG_SEAT_VERBS: ReadonlyMap<string, GenericZeroArgSeatVerb> = new Map(
  (Object.entries(SESSION_VERBS) as readonly [string, SessionVerbRow][]).flatMap(([key, row]) => {
    if (row.carrier !== 'empty-detail') return []
    if (row.daemon?.op !== SESSION_VERBS.sessionControl.daemon.op || row.daemon.action === undefined) return []
    if (row.runner?.from !== 'host' || row.runner.kind !== 'request') return []
    const action = row.daemon.action
    return [[action, {
      key: key as EmptyDetailSeatVerbKey,
      action,
      olderDetail: EMPTY_DETAIL_OLDER_DETAIL[action] ?? `this session's runner predates ${action} · /daemon restart, then reopen the session`,
    }] as const]
  }),
)

export function isGenericSeatVerb(action: string): boolean {
  return GENERIC_ZERO_ARG_SEAT_VERBS.has(action)
}

export async function forwardGenericSeatVerb(
  sessionId: string,
  action: string,
  roster: SeatRosterPort,
  dir?: string,
  opts?: { deadlineMs?: number },
): Promise<SeatVerbOutcome> {
  const entry = GENERIC_ZERO_ARG_SEAT_VERBS.get(action)
  if (entry === undefined) return { outcome: 'refused', detail: `unregistered session action: ${action}` }
  return runSeatVerb(sessionId, {}, roster, dir, {
    verb: entry.key,
    label: entry.action,
    ...(opts?.deadlineMs !== undefined ? { deadlineMs: opts.deadlineMs } : {}),
    onAnswer: (result, runnerId) => {
      console.error(`[daemon] seat ${entry.action} applied: ${runnerId}`)
      return appliedDetail(result)
    },
    olderDetail: entry.olderDetail,
  })
}

export async function pauseSessionGate(
  sessionId: string,
  paused: boolean,
  roster: SeatRosterPort,
  dir?: string,
  opts?: { deadlineMs?: number },
): Promise<SeatVerbOutcome> {
  return runSeatVerb(sessionId, { paused }, roster, dir, {
    verb: 'pauseGate',
    deadlineMs: opts?.deadlineMs ?? CREWMATE_VERB_ANSWER_DEADLINE_MS,
    onAnswer: (result, runnerId) => {
      console.error(`[daemon] seat ${SESSION_VERBS.pauseGate.daemon.action} applied: ${runnerId} → ${paused ? 'closed' : 'open'}`)
      return appliedDetail(result)
    },
    olderDetail: "this session's runner predates the pause gate · /daemon restart, then reopen the session",
  })
}

export async function postSessionBoard(
  sessionId: string,
  post: BoardPostRequestV1,
  roster: SeatRosterPort,
  dir?: string,
  opts?: { deadlineMs?: number },
): Promise<SeatVerbOutcome> {
  const params = { client_op_id: post.clientOpId, channel: post.channel, ...(post.target === undefined ? {} : { target: post.target }), text: post.text }
  return runSeatVerb(sessionId, params, roster, dir, {
    verb: 'postBoard',
    deadlineMs: opts?.deadlineMs ?? CREWMATE_VERB_ANSWER_DEADLINE_MS,
    refreshFacts: 'none',
    onAnswer: result => ({ outcome: result.ok ? 'applied' : 'refused', detail: JSON.stringify(result) }),
    olderDetail: "this session's runner predates the owner's board posts · /daemon restart, then reopen the session",
  })
}

export const LEAVE_ANSWER_DEADLINE_MS = 130_000

export async function leaveSession(
  sessionId: string,
  roster: SeatRosterPort,
  dir?: string,
  opts?: { deadlineMs?: number },
): Promise<SeatVerbOutcome> {
  return runSeatVerb(sessionId, {}, roster, dir, {
    verb: 'leave',
    deadlineMs: opts?.deadlineMs ?? LEAVE_ANSWER_DEADLINE_MS,
    refreshFacts: 'none',
    onAnswer: (result, runnerId) => {
      console.error(`[daemon] seat ${SESSION_VERBS.leave.daemon.action} answered: ${runnerId} → note ${result.note} · ledger ${result.ledger}`)
      return appliedDetail(result)
    },
    olderDetail: "this session's runner predates the note at close · /daemon restart, then reopen the session",
  })
}

export const QUIESCE_ANSWER_DEADLINE_MS = SESSION_VERBS.quiesce.runner.deadlineMs

export async function quiesceSessionRunner(
  runnerId: string,
  request: QuiescenceRequest,
  roster: Pick<SeatRosterPort, 'door'>,
  opts?: { deadlineMs?: number },
): Promise<QuiescenceAnswer> {
  const deadlineMs = opts?.deadlineMs ?? QUIESCE_ANSWER_DEADLINE_MS
  const asked = await askSeat(roster, runnerId, SESSION_VERBS.quiesce.runner.name, { action: request.action, token: request.token }, `quiesce ${request.action}`, deadlineMs)
  if (!asked.ok) return { ok: false, token: request.token, reason: asked.failure.words }
  const { token, phase } = asked.result
  if (token !== request.token || (phase !== 'prepared' && phase !== 'committed' && phase !== 'cancelled')) {
    return { ok: false, token: request.token, reason: 'the runner answered with another token or phase' }
  }
  return { ok: true, token: request.token, phase }
}

export const WITHDRAW_ANSWER_DEADLINE_MS = SESSION_VERBS.withdrawSend.runner.deadlineMs

export type SeatWithdrawOutcome = SeatVerbOutcome & { withdrawn?: boolean; text?: string; reason?: 'taken' | 'unknown' }

export async function withdrawSessionSend(
  sessionId: string,
  clientMessageId: string,
  roster: SeatRosterPort,
  dir?: string,
  opts?: { deadlineMs?: number },
): Promise<SeatWithdrawOutcome> {
  return runSeatVerb(sessionId, { id: clientMessageId }, roster, dir, {
    verb: 'withdrawSend',
    label: 'withdraw',
    deadlineMs: opts?.deadlineMs ?? WITHDRAW_ANSWER_DEADLINE_MS,
    validate: () => (clientMessageId === '' ? { outcome: 'refused', detail: `${SESSION_VERBS.withdrawSend.daemon.action} requires clientMessageId` } : undefined),
    onAnswer: payload => {
      if (payload.withdrawn) return { outcome: 'applied', withdrawn: true, text: payload.text }
      return { outcome: 'refused', withdrawn: false, reason: payload.reason, detail: payload.reason === 'taken' ? 'the runner already took the line' : "the runner's queue never held the line" }
    },
    olderDetail: "the session's runner predates the recall — /daemon restart when ready, then reopen the session",
  })
}

export async function actOnSessionMcp(sessionId: string, action: { name: string; action: 'authenticate' | 'reconnect' | 'cancel-auth' }, roster: SeatRosterPort): Promise<SeatVerbOutcome> {
  const rec = liveRecordBySession(sessionId)
  const door = rec ? roster.door(rec.runnerId) : undefined
  if (!rec || !door || door.closed) return { outcome: 'refused', detail: 'the session has no live runner' }
  try {
    const result = await door.request(SESSION_VERBS.mcpAction.runner.name, action, { deadlineMs: SESSION_VERBS.mcpAction.runner.deadlineMs })
    requestSessionFacts(rec.runnerId, roster, { immediate: true })
    return result
  } catch (error) {
    return { outcome: 'refused', detail: error instanceof Error ? error.message : String(error) }
  }
}

const MCP_TOOLS_ANSWER_DEADLINE_MS = SESSION_VERBS.mcpTools.runner.deadlineMs

export async function listSessionMcpTools(
  sessionId: string,
  name: string,
  roster: SeatRosterPort,
  dir?: string,
  opts?: { deadlineMs?: number },
): Promise<SeatVerbOutcome & { mcpTools?: McpToolsV1 }> {
  return runSeatVerb(sessionId, { name }, roster, dir, {
    verb: 'mcpTools',
    label: 'MCP tools list',
    deadlineMs: opts?.deadlineMs ?? MCP_TOOLS_ANSWER_DEADLINE_MS,
    refreshFacts: 'none',
    onAnswer: result => ({ outcome: 'applied', mcpTools: mcpToolsFromWire(result) }),
    olderDetail: "the session's runner predates the MCP tools list — /daemon restart when ready, then reopen the session",
  })
}

export const PERMISSION_MODE_ANSWER_DEADLINE_MS = SESSION_VERBS.setPermissionMode.runner.deadlineMs

export async function setSessionPermissionMode(
  sessionId: string,
  mode: string,
  roster: SeatRosterPort,
  dir?: string,
  opts?: { deadlineMs?: number },
): Promise<SeatVerbOutcome> {
  return runSeatVerb(sessionId, { mode }, roster, dir, {
    verb: 'setPermissionMode',
    label: 'mode change',
    deadlineMs: opts?.deadlineMs ?? PERMISSION_MODE_ANSWER_DEADLINE_MS,
    onAnswer: (result, runnerId) => ({ outcome: 'applied', detail: `${runnerId} mode → ${result.mode}` }),
    onFailure: (failure, id) => {
      if (failure.kind === 'left' && id === null) return { outcome: 'refused', detail: failure.words }
      if (failure.kind === 'left' || failure.kind === 'silent') return { outcome: 'refused', detail: `${failure.words} — the band follows its facts` }
      return { outcome: 'refused', detail: failure.words }
    },
  })
}

export function refreshSessionFacts(sessionId: string, roster: SeatRosterPort, dir?: string): SeatVerbOutcome {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return UNKNOWN_SESSION_REFUSAL
  requestSessionFacts(rec.runnerId, roster, { immediate: true }, dir)
  return { outcome: 'applied', detail: `facts requested from ${rec.runnerId}` }
}
