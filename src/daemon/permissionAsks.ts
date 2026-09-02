// ============================================================================
//  daemon/permissionAsks — the background ask wire:
//  a BACKGROUND session's permission ask reaches the operator instead of
//  dying silently.
//
//  The transport: switchboard children spawn with --permission-prompt-tool
//  stdio, so an 'ask' decision becomes a can_use_tool control_request frame
//  on the child's stream-json stdout and the turn PARKS until a
//  control_response lands on its stdin (the same protocol SDK hosts speak).
//  The roster's drain surfaces those frames here; each becomes a durable
//  needs-you obligation ("… asks to run X — allow?") in the workspace's
//  crew store — the same rows the rail and the coordinator's board snapshot
//  already read. The answer rides concourseControl action
//  'answer-permission' back through the child's control channel; allow
//  echoes the ORIGINAL input (the permission-tool contract), deny carries a
//  plain refusal the model reads.
//
//  Pending asks are in-memory by design: a daemon death kills the children
//  with it (parent-watch), so no ask outlives this process; the obligation
//  row persists and the kernel's worker-settled supersede reconciles it.
//
//  Expiry (sweep #2 rider R4): a parked ask is a turn holding a seat
//  and a worker, waiting on a human who may never come. Each worker ask
//  arms the shared inactivity deadline (src/utils/deadline.ts); when it
//  fires, the child receives a typed DENIAL that says what happened and what
//  to do about it, and the obligation settles visibly as withdrawn-by-expiry
//  — never a silent disappearance, never a turn parked forever (law 1).
//  The threshold is the registered MERCURY_PERMISSION_ASK_EXPIRY_MINUTES
//  knob (default 30; 0 disables). Daemon-local git-init offers never expire:
//  nothing is parked behind them.
// ============================================================================
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

/** SB-C8: the git-init ask's durable identity sidecar. The pending map is
 *  in-memory by design, but a git-init ask must survive a daemon restart —
 *  its obligation row does, and the answer path is synchronous, so the
 *  requestId→folder pair lives in one tiny daemon-dir file (bounded: rows
 *  delete on answer). */
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

/** The live expiry limit in ms (0 ⇒ never expire). */
export function permissionAskExpiryMs(): number {
  return minutesKnobToMs(flagEnv('MERCURY_PERMISSION_ASK_EXPIRY_MINUTES'), DEFAULT_PERMISSION_ASK_EXPIRY_MINUTES)
}

/** The child's control channel — the roster; injected so the prover can
 *  drive expiry with a recording double. */
export interface AskControlChannel {
  control(short: string, frame: string): boolean
}

/** The typed denial the model reads when nobody answered in time — what
 *  happened and what to do next (the actionable half). Exported for the prover. */
export function expiredAskDenialMessage(toolName: string, limitMs: number, cause: 'expired' | 'evicted'): string {
  // Worded so isDenialResultText classifies it as a denial (the ' has been
  // denied' lead + the shared DENIAL_WORKAROUND_GUIDANCE tail), the same as
  // every other auto-denial — otherwise an expired/evicted ask wears the amber
  // "ordinary failure" lead like the switchboard No did (W6 sibling).
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
  /** The FULL payload the focused chat's consent card renders — the asking
   *  tool use, the rules the session offers for "allow always", the blocked
   *  path, the decision reason, a composed description. */
  toolUseId?: string
  suggestions?: PermissionUpdate[]
  blockedPath?: string
  decisionReason?: string
  /** The structured reason (the matched rule, the mode, a hook, a safety
   *  check, per-part verdicts) the focused chat's card explains — the
   *  plain-text `decisionReason` is its fallback spelling. */
  decisionReasonDetail?: DecisionReasonWireV1
  description?: string
  obligationId?: string
  askedAt?: number
  deadline?: InactivityDeadline
  /** The child's return path, carried BY the ask so any evictor — the
   *  worker door, the git-init door, expiry — can deliver the typed denial
   *  without re-threading the roster. */
  channel?: AskControlChannel
  /** A DAEMON-LOCAL ask — no worker
   *  behind it; the allow answer EXECUTES here (git init + base commit)
   *  instead of a control_response into a child. */
  local?: 'git-init'
}

const pending = new Map<string, PendingAsk>()
const MAX_PENDING = 200

/** The session's parked asks, FULL payload, published for the focused
 *  chat (the seat projection the screen's daemon connector watches).
 *  Every mint, answer, expiry, eviction and cancel republishes; an empty
 *  list is published too, so a settled ask leaves the card at once. */
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

/** The full answer a consent card gives — never a bare y/n. */
export interface SeatAskAnswerV1 {
  /** The input as (possibly) edited on the card; the original when absent. */
  updatedInput?: Record<string, unknown>
  /** Always-allow rules the answer carries (the card's offered rule). */
  permissionUpdates?: PermissionUpdate[]
  /** Deny: the reason the model reads. */
  feedback?: string
  /** Deny: also abort the session's turn (the card's abort verb). */
  interrupt?: boolean
}

/**
 * Retire a parked worker ask nobody answered: the child gets a typed denial
 * through its control channel (the same frame shape an operator's deny
 * rides), the obligation settles as withdrawn by the daemon with the cause
 * in its settlement, and the ledger names it once. A child whose control
 * channel is already gone simply loses the row — nothing is parked behind
 * a dead channel.
 */
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
  const obligationId = ask.obligationId
  if (obligationId !== undefined) {
    void import('../services/crew/obligations.js')
      .then(o =>
        o.resolveObligation(obligationId, {
          kind: 'withdrawn',
          by: cause === 'expired' ? `daemon: expired unanswered after ${formatLimit(limitMs)}` : 'daemon: dropped unanswered (parked-ask table full)',
          scope: 'switchboard',
        } as Parameters<typeof o.resolveObligation>[1]),
      )
      .catch(() => {})
  }
}

/** The roster drain's hook: mint the needs-you obligation for a switchboard
 *  child's can_use_tool control_request. Fail-soft everywhere — a malformed
 *  frame or a failed store write never disturbs the drain. */
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
    // The table is full: the OLDEST worker ask leaves — with a typed denial
    // into its child, never a silent delete that parks that turn forever.
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
    ...(suggestions !== undefined && suggestions.length > 0 ? { suggestions } : {}),
    ...(typeof request.blocked_path === 'string' ? { blockedPath: request.blocked_path } : {}),
    ...(typeof request.decision_reason === 'string' ? { decisionReason: request.decision_reason } : {}),
    // Kept only when it decodes as a well-formed reason: the card explains
    // the ask or explains nothing, never a malformed line.
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
  // ONE STORE (operator drive-10 root cause): the board reads the DEFAULT
  // crew store only — a workspace-rooted dir minted rows into a file no
  // surface ever read (they sat invisible in the project folder).
  void upsertObligation({
    ref: `permission:${requestId}`,
    sessionId: rec.sessionId,
    question: `"${rec.title ?? short}" asks to run ${toolName} — allow?`,
    owner: 'operator',
    scope: 'switchboard',
  })
    .then(res => {
      ask.obligationId = res.obligationId
    })
    .catch(err => {
      logForDebugging(`[daemon] permission-ask obligation write failed: ${err}`)
    })
}

/** the git-init OFFER — one open ask per folder,
 *  minted when a launch holds on 'no-repository'/'unborn-head'. The
 *  operator's y (rail / composer y-grammar) or the coordinator's existing
 *  answer verb allows it; the daemon then runs git init + one base commit
 *  and the held launch starts on its own (the admission pump replays it).
 *  Deny or silence changes nothing — the folder is never mutated silently. */
export function mintGitInitAsk(folder: string): { requestId: string } {
  for (const [id, a] of pending) {
    if (a.local === 'git-init' && a.workspaceId === folder) return { requestId: id }
  }
  // SB-C8 (close audit): DETERMINISTIC identity — a daemon restart or a
  // second held launch re-mints the SAME ref, so upsertObligation's open-ref
  // dedupe collapses to one row instead of stacking ghosts.
  const requestId = `git-init:${createHash('sha1').update(folder).digest('hex').slice(0, 12)}`
  writeGitInitAsks({ ...readGitInitAsks(), [requestId]: folder })
  if (pending.size >= MAX_PENDING) {
    // The same law as the worker door (the DF-101 deny-replay family): every
    // dangling ask SETTLES. A bare delete parked the evicted child forever —
    // its typed denial never sent, its own expiry dead-ended on the
    // pending-identity guard. The ask's carried channel is the return path.
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
  // ONE STORE (drive-10): the DEFAULT crew store — the board's only read.
  void upsertObligation({
    ref: `permission:${requestId}`,
    sessionId: ask.sessionId,
    question: `this folder has no git — start one in ${folder} so sessions can fork it?`,
    owner: 'operator',
    scope: 'switchboard',
  })
    .then(res => {
      ask.obligationId = res.obligationId
    })
    .catch(err => {
      logForDebugging(`[daemon] git-init ask obligation write failed: ${err}`)
    })
  return { requestId }
}

/**
 * A child that abandons its own parked ask (its turn was interrupted; the
 * request aborted on its side) says so with control_cancel_request. The
 * ask retires here and its NEEDS YOU row withdraws — never a ghost the
 * rail keeps asking about, never a turn the operator answers into a void.
 */
export function onWorkerControlCancel(requestId: string, dir?: string): void {
  const ask = pending.get(requestId)
  if (!ask || ask.local !== undefined) return
  pending.delete(requestId)
  ask.deadline?.cancel()
  publishAsksFor(ask.sessionId, dir)
  const obligationId = ask.obligationId
  if (obligationId !== undefined) {
    void import('../services/crew/obligations.js')
      .then(o =>
        o.resolveObligation(obligationId, {
          kind: 'withdrawn',
          by: 'daemon: the session moved on (its ask was cancelled)',
          scope: 'switchboard',
        } as Parameters<typeof o.resolveObligation>[1]),
      )
      .catch(() => {})
  }
}

/** Answer a parked ask: control_response into the child (allow carries
 *  the card's input — the original when unedited — and the rules it
 *  offered; deny carries the reason the model reads and, from the card's
 *  abort verb, the turn interrupt), settle the obligation. A daemon-local
 *  ask executes HERE instead. */
export function answerPermissionAsk(
  requestId: string,
  allow: boolean,
  roster: { control(short: string, frame: string): boolean } | undefined,
  by: string,
  hooks?: {
    /** Drive-11 (operator finding): a y that lands git must START the
     *  launches waiting on it — the wiring fires the daemon-side replay and
     *  returns the sync projection of what is starting so THIS receipt
     *  names it (the coordinator and the rail read the same sentence). */
    onGitReady?: (folder: string) => ReadonlyArray<{ clientMessageId: string; title?: string }>
    /** THE RULED No LEG: a DENY
     *  proceeds lawfully — where the folder is FREE the oldest DEFAULTED
     *  launch replays through the same door and runs there as it is, alone
     *  (exclusive); a held folder starts nothing and those stay queued.
     *  Same shape as onGitReady: the sync projection names what starts. */
    onDenyProceed?: (folder: string) => ReadonlyArray<{ clientMessageId: string; title?: string }>
  },
  answer?: SeatAskAnswerV1,
): { outcome: 'applied' | 'refused'; detail?: string } {
  let ask = pending.get(requestId)
  if (!ask && requestId.startsWith('git-init:')) {
    // SB-C8: pending asks are in-memory — a daemon restart loses the map
    // while the obligation row survives. The allow leg needs only the
    // folder, and the row's 'folder:<dir>' subject carries it: reconstruct
    // and execute instead of bouncing the operator's y off a cold map.
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
    const settleObligation = (): void => {
      const obligationId = ask.obligationId
      if (obligationId !== undefined) {
        void import('../services/crew/obligations.js')
          .then(o =>
            o.resolveObligation(obligationId, {
              kind: 'answered',
              by,
              scope: 'switchboard',
            } as Parameters<typeof o.resolveObligation>[1]),
          )
          .catch(() => {})
      }
    }
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
      // THE RULED No LEG (board controls item 5): the operator's recorded
      // intent — "No proceeds" — executes LAWFULLY under the five-lease:
      // where the folder is FREE the oldest DEFAULTED launch replays
      // through the same idempotent door and admits EXCLUSIVE (it runs in
      // the folder as it is, alone; an explicit worktree pick is never
      // overridden, a held folder admits nothing — those stay queued). The
      // receipt speaks whichever truth happened. The old clobber warning
      // RETIRED with its reason: exclusive occupancy shares nothing, so
      // there is nothing to clobber — its spirit lives in the dispatched
      // agents' shared-folder ground notes, where sharing is real.
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
  // The model-facing denial must be one the classifier reads AS a denial: the
  // in-process path (hooks/toolPermission/PermissionContext) builds it from the
  // canon, so isDenialResultText paints the crimson denial glyph and the model
  // is told the action was NOT run and to stop and wait. The switchboard minted
  // its own sentence ("denied from the switchboard by <by>"), which matched no
  // clause of isDenialResultText — so the operator's own No wore the amber
  // "ordinary failure" lead and the model got none of the STOP guidance (W6
  // interrupt-and-cancel: switchboard denial reads as an ordinary failure). The
  // obligation record below still carries `by`, so the operator's identity is
  // kept where it belongs — off the model's transcript.
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
  const obligationId = ask.obligationId
  if (obligationId !== undefined) {
    void import('../services/crew/obligations.js')
      .then(o =>
        o.resolveObligation(obligationId, {
          kind: 'answered',
          by,
          scope: 'switchboard',
        } as Parameters<typeof o.resolveObligation>[1]),
      )
      .catch(() => {})
  }
  return {
    outcome: 'applied',
    detail: `${allow ? 'allowed' : 'denied'} ${ask.toolName} for ${ask.workerId}`,
  }
}

/** Prover/diagnostic projection of the parked asks. */
export function listPendingPermissionAsks(): ReadonlyArray<{
  requestId: string
  workerId: string
  sessionId: string
  toolName: string
  askedAt?: number
}> {
  return [...pending.entries()].map(([requestId, a]) => ({
    requestId,
    workerId: a.workerId,
    sessionId: a.sessionId,
    toolName: a.toolName,
    ...(a.askedAt !== undefined ? { askedAt: a.askedAt } : {}),
  }))
}
