import { rewindOutcomeFromWire } from '../../services/engine-connector/seatWire.js'
import type { QuiescenceRequest, QuiescenceAnswer } from '../runnerQuiescence.js'
import type { SessionRewindMode, SessionRewindOutcomeV1, BoardPostRequestV1, McpToolsV1 } from '../protocol.js'
import { mcpToolsFromWire } from '../../services/mcp/toolsAnswer.js'
import { liveRecordBySession, seatBusy, type SeatRosterPort } from './state.js'
import { askSeat, runnerAnswered, NO_DOOR_DETAIL, type DoorFailure, type SeatVerbOutcome } from './door.js'
import { requestSessionFacts } from './facts.js'

export const REWIND_ANSWER_DEADLINE_MS = 30_000

function refusedRewind(mode: SessionRewindMode, refusal: NonNullable<SessionRewindOutcomeV1['refusal']>, detail: string): SessionRewindOutcomeV1 {
  return { outcome: 'refused', mode, refusal, detail }
}

export async function rewindSession(
  sessionId: string,
  req: { mode: SessionRewindMode; userMessageId: string; dryRun?: boolean },
  roster: SeatRosterPort,
  dir?: string,
  opts?: { deadlineMs?: number; fileRestore?: import('../protocol.js').SessionFileRestoreRequest },
): Promise<SessionRewindOutcomeV1> {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return refusedRewind(req.mode, 'unknown-session', 'no live worker record owns this session')
  if (seatBusy(rec.runnerId, roster)) {
    return refusedRewind(req.mode, 'turn-active', 'a turn is running in this session — press esc to stop it, then /rewind again')
  }
  const deadlineMs = opts?.deadlineMs ?? REWIND_ANSWER_DEADLINE_MS
  const fileRestore = opts?.fileRestore
  const asked = fileRestore === undefined
    ? await askSeat(roster, rec.runnerId, 'session/rewind', { user_message_id: req.userMessageId, mode: req.mode, ...(req.dryRun === true ? { dry_run: true } : {}) }, 'rewind', deadlineMs)
    : await askSeat(roster, rec.runnerId, 'session/file_restore', {
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

export const AGENT_VERB_ANSWER_DEADLINE_MS = 10_000

export type SessionAgentVerb = 'stop-agent' | 'resume-agent'

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

export async function controlSessionAgent(
  sessionId: string,
  agentId: string,
  verb: SessionAgentVerb,
  roster: SeatRosterPort,
  dir?: string,
  opts?: { note?: string; deadlineMs?: number },
): Promise<SeatVerbOutcome> {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
  if (agentId === '') return { outcome: 'refused', detail: `${verb} requires agentId` }
  const deadlineMs = opts?.deadlineMs ?? AGENT_VERB_ANSWER_DEADLINE_MS
  const params = { agent_id: agentId, ...(opts?.note !== undefined ? { note: opts.note } : {}) }
  const asked = await askSeat(roster, rec.runnerId, verb === 'stop-agent' ? 'agent/stop' : 'agent/resume', params, verb, deadlineMs)
  if (runnerAnswered(asked)) requestSessionFacts(rec.runnerId, roster, { immediate: true }, dir)
  if (asked.ok) {
    console.error(`[daemon] seat ${verb} applied: ${rec.runnerId} → ${agentId}`)
    return appliedDetail(asked.result)
  }
  return crewVerbRefusal(asked.failure, "the session's runner predates the crew stop and resume verbs — /daemon restart when ready, then reopen the session")
}

export async function backgroundSessionShell(
  sessionId: string,
  roster: SeatRosterPort,
  dir?: string,
  opts?: { deadlineMs?: number },
): Promise<SeatVerbOutcome> {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
  const deadlineMs = opts?.deadlineMs ?? AGENT_VERB_ANSWER_DEADLINE_MS
  const asked = await askSeat(roster, rec.runnerId, 'shell/background', {}, 'background-shell', deadlineMs)
  if (runnerAnswered(asked)) requestSessionFacts(rec.runnerId, roster, { immediate: true }, dir)
  if (asked.ok) {
    console.error(`[daemon] seat background-shell applied: ${rec.runnerId}`)
    return appliedDetail(asked.result)
  }
  return crewVerbRefusal(asked.failure, "this session's runner predates shift+B · /daemon restart, then reopen the session")
}

export async function sendSessionNow(
  sessionId: string,
  roster: SeatRosterPort,
  dir?: string,
  opts?: { deadlineMs?: number },
): Promise<SeatVerbOutcome> {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
  const deadlineMs = opts?.deadlineMs ?? AGENT_VERB_ANSWER_DEADLINE_MS
  const asked = await askSeat(roster, rec.runnerId, 'session/send_now', {}, 'send-now', deadlineMs)
  if (runnerAnswered(asked)) requestSessionFacts(rec.runnerId, roster, { immediate: true }, dir)
  if (asked.ok) {
    console.error(`[daemon] seat send-now applied: ${rec.runnerId}`)
    return appliedDetail(asked.result)
  }
  return crewVerbRefusal(asked.failure, "this session's runner predates ctrl+s s · /daemon restart, then reopen the session")
}

export async function pauseSessionGate(
  sessionId: string,
  paused: boolean,
  roster: SeatRosterPort,
  dir?: string,
  opts?: { deadlineMs?: number },
): Promise<SeatVerbOutcome> {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
  const deadlineMs = opts?.deadlineMs ?? AGENT_VERB_ANSWER_DEADLINE_MS
  const asked = await askSeat(roster, rec.runnerId, 'session/pause_gate', { paused }, 'pause-gate', deadlineMs)
  if (runnerAnswered(asked)) requestSessionFacts(rec.runnerId, roster, { immediate: true }, dir)
  if (asked.ok) {
    console.error(`[daemon] seat pause-gate applied: ${rec.runnerId} → ${paused ? 'closed' : 'open'}`)
    return appliedDetail(asked.result)
  }
  return crewVerbRefusal(asked.failure, "this session's runner predates the pause gate · /daemon restart, then reopen the session")
}

export async function postSessionBoard(
  sessionId: string,
  post: BoardPostRequestV1,
  roster: SeatRosterPort,
  dir?: string,
  opts?: { deadlineMs?: number },
): Promise<SeatVerbOutcome> {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
  const deadlineMs = opts?.deadlineMs ?? AGENT_VERB_ANSWER_DEADLINE_MS
  const asked = await askSeat(roster, rec.runnerId, 'session/board_post', { client_op_id: post.clientOpId, channel: post.channel, ...(post.target === undefined ? {} : { target: post.target }), text: post.text }, 'board-post', deadlineMs)
  if (asked.ok) return { outcome: asked.result.ok ? 'applied' : 'refused', detail: JSON.stringify(asked.result) }
  return crewVerbRefusal(asked.failure, "this session's runner predates the owner's board posts · /daemon restart, then reopen the session")
}

export const LEAVE_ANSWER_DEADLINE_MS = 130_000

export async function leaveSession(
  sessionId: string,
  roster: SeatRosterPort,
  dir?: string,
  opts?: { deadlineMs?: number },
): Promise<SeatVerbOutcome> {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
  const deadlineMs = opts?.deadlineMs ?? LEAVE_ANSWER_DEADLINE_MS
  const asked = await askSeat(roster, rec.runnerId, 'session/leave', {}, 'leave', deadlineMs)
  if (asked.ok) {
    console.error(`[daemon] seat leave answered: ${rec.runnerId} → note ${asked.result.note} · ledger ${asked.result.ledger}`)
    return appliedDetail(asked.result)
  }
  return crewVerbRefusal(asked.failure, "this session's runner predates the note at close · /daemon restart, then reopen the session")
}

export const QUIESCE_ANSWER_DEADLINE_MS = 10_000

export async function quiesceSessionRunner(
  runnerId: string,
  request: QuiescenceRequest,
  roster: Pick<SeatRosterPort, 'door'>,
  opts?: { deadlineMs?: number },
): Promise<QuiescenceAnswer> {
  const deadlineMs = opts?.deadlineMs ?? QUIESCE_ANSWER_DEADLINE_MS
  const asked = await askSeat(roster, runnerId, 'session/quiesce', { action: request.action, token: request.token }, `quiesce ${request.action}`, deadlineMs)
  if (!asked.ok) return { ok: false, token: request.token, reason: asked.failure.words }
  const { token, phase } = asked.result
  if (token !== request.token || (phase !== 'prepared' && phase !== 'committed' && phase !== 'cancelled')) {
    return { ok: false, token: request.token, reason: 'the runner answered with another token or phase' }
  }
  return { ok: true, token: request.token, phase }
}

export const WITHDRAW_ANSWER_DEADLINE_MS = 5_000

export type SeatWithdrawOutcome = SeatVerbOutcome & { withdrawn?: boolean; text?: string; reason?: 'taken' | 'unknown' }

export async function withdrawSessionSend(
  sessionId: string,
  clientMessageId: string,
  roster: SeatRosterPort,
  dir?: string,
  opts?: { deadlineMs?: number },
): Promise<SeatWithdrawOutcome> {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
  if (clientMessageId === '') return { outcome: 'refused', detail: 'withdraw-send requires clientMessageId' }
  const deadlineMs = opts?.deadlineMs ?? WITHDRAW_ANSWER_DEADLINE_MS
  const asked = await askSeat(roster, rec.runnerId, 'queue/withdraw', { id: clientMessageId }, 'withdraw', deadlineMs)
  if (runnerAnswered(asked)) requestSessionFacts(rec.runnerId, roster, { immediate: true }, dir)
  if (asked.ok) {
    const payload = asked.result
    if (payload.withdrawn) return { outcome: 'applied', withdrawn: true, text: payload.text }
    return { outcome: 'refused', withdrawn: false, reason: payload.reason, detail: payload.reason === 'taken' ? 'the runner already took the line' : "the runner's queue never held the line" }
  }
  return crewVerbRefusal(asked.failure, "the session's runner predates the recall — /daemon restart when ready, then reopen the session")
}

export async function actOnSessionMcp(sessionId: string, action: { name: string; action: 'authenticate' | 'reconnect' | 'cancel-auth' }, roster: SeatRosterPort): Promise<SeatVerbOutcome> {
  const rec = liveRecordBySession(sessionId)
  const door = rec ? roster.door(rec.runnerId) : undefined
  if (!rec || !door || door.closed) return { outcome: 'refused', detail: 'the session has no live runner' }
  try {
    const result = await door.request('mcp/action', action, { deadlineMs: 300_000 })
    requestSessionFacts(rec.runnerId, roster, { immediate: true })
    return result
  } catch (error) {
    return { outcome: 'refused', detail: error instanceof Error ? error.message : String(error) }
  }
}

const MCP_TOOLS_ANSWER_DEADLINE_MS = 10_000

export async function listSessionMcpTools(
  sessionId: string,
  name: string,
  roster: SeatRosterPort,
  dir?: string,
  opts?: { deadlineMs?: number },
): Promise<SeatVerbOutcome & { mcpTools?: McpToolsV1 }> {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
  const asked = await askSeat(roster, rec.runnerId, 'mcp/tools', { name }, 'MCP tools list', opts?.deadlineMs ?? MCP_TOOLS_ANSWER_DEADLINE_MS)
  if (asked.ok) return { outcome: 'applied', mcpTools: mcpToolsFromWire(asked.result) }
  return crewVerbRefusal(asked.failure, "the session's runner predates the MCP tools list — /daemon restart when ready, then reopen the session")
}

export const PERMISSION_MODE_ANSWER_DEADLINE_MS = 5_000

export async function setSessionPermissionMode(
  sessionId: string,
  mode: string,
  roster: SeatRosterPort,
  dir?: string,
  opts?: { deadlineMs?: number },
): Promise<SeatVerbOutcome> {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
  const deadlineMs = opts?.deadlineMs ?? PERMISSION_MODE_ANSWER_DEADLINE_MS
  const asked = await askSeat(roster, rec.runnerId, 'session/set_mode', { mode }, 'mode change', deadlineMs)
  if (runnerAnswered(asked)) requestSessionFacts(rec.runnerId, roster, { immediate: true }, dir)
  if (asked.ok) return { outcome: 'applied', detail: `${rec.runnerId} mode → ${asked.result.mode}` }
  const { failure } = asked
  if (failure.kind === 'left' && asked.id === null) return { outcome: 'refused', detail: failure.words }
  if (failure.kind === 'left' || failure.kind === 'silent') return { outcome: 'refused', detail: `${failure.words} — the band follows its facts` }
  return { outcome: 'refused', detail: failure.words }
}

export function refreshSessionFacts(sessionId: string, roster: SeatRosterPort, dir?: string): SeatVerbOutcome {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
  requestSessionFacts(rec.runnerId, roster, { immediate: true }, dir)
  return { outcome: 'applied', detail: `facts requested from ${rec.runnerId}` }
}
