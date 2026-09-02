/**
 * Scribe Mode "Amanuensis" — the Scribe↔Implementer protocol envelopes that
 * ride the EXISTING file teammate-mailbox bus. Modeled on teammateMailbox.ts's
 * create/is helpers: each builder returns a JSON-serializable envelope tagged
 * `type: 'scribe_protocol'` with a `kind` sub-discriminator and a `request_id`
 * (reusing generateRequestId), and each classifier parses a message's text back
 * into the typed envelope (or null).
 *
 * The outer `type: 'scribe_protocol'` keeps these DISTINCT from the existing
 * teammate protocol types (isStructuredProtocolMessage checks its own closed
 * list and never matches these), so the two protocols coexist on one mailbox.
 * The feature gate (scribeBusEnabled) is applied at the call sites (SendMessage
 * + the inbox demux, Task 3.2) — these builders/classifiers are pure.
 *
 * Four kinds:
 *   - dispatch  Scribe → Implementer: a refined, well-specified task to execute.
 *   - escalate  Implementer → Scribe: a blocker / ambiguity / out-of-scope ask.
 *   - progress  Implementer → Scribe: a status heartbeat (started/working/…).
 *   - control   either direction: pause/resume/stop/clear/ack of the work.
 */
import { generateRequestId } from '../agentId.js'

export const SCRIBE_PROTOCOL_TYPE = 'scribe_protocol' as const

export type ScribeEnvelopeKind = 'dispatch' | 'escalate' | 'progress' | 'control' | 'note'

export const SCRIBE_ENVELOPE_KINDS: readonly ScribeEnvelopeKind[] = [
  'dispatch',
  'escalate',
  'progress',
  'control',
  'note',
]

/** #47 `/all` — the SINGLE source of truth for the labels both delivery sites (the Scribe's
 *  command stdout + the Implementer's stdin frame) AND both behavioural packs quote, so the
 *  marker can never drift between where it's emitted and where the agents are told to recognize
 *  it. A broadcast note (NoteEnvelope.broadcast) renders OPERATOR_BROADCAST_LABEL on both sides;
 *  a plain note renders OPERATOR_NOTE_LABEL. */
export const OPERATOR_BROADCAST_LABEL = '[operator broadcast]'
export const OPERATOR_NOTE_LABEL = '[operator note]'

interface ScribeEnvelopeBase {
  type: typeof SCRIBE_PROTOCOL_TYPE
  kind: ScribeEnvelopeKind
  request_id: string
  from: string
  timestamp: string
}

export interface DispatchEnvelope extends ScribeEnvelopeBase {
  kind: 'dispatch'
  /** The refined, well-specified task the Implementer should execute. */
  task: string
  title?: string
  priority?: 'normal' | 'high'
  /** SUPERSEDES an earlier dispatch (its request_id): the bridge drops that earlier
   *  dispatch if it is still queued (unread, not yet delivered) so a correction never
   *  stacks behind the work it replaces. An already-in-flight target can't be un-delivered
   *  (a stream-json turn isn't interruptible mid-frame) — it completes, but the Scribe's
   *  ledger marks it superseded. The operator-correction primitive (#41 R1c). */
  refRequestId?: string
  /** Per-task routing hint: the dispatcher's judgment
   *  for THIS task. Optional — when absent the daemon's deterministic fallback
   *  (dispatchRouter → the local-fallback route compile) decides. `effort` is
   *  validated by the daemon (normalizeRouteEffort); `model` is the
   *  RESOLVED route target, re-validated fail-closed through seatSlots at the
   *  reconfigure seam — a junk model can never reach a spawn spec. Old
   *  {effort, lane} envelopes remain fully functional (total decoders;
   *  proven by scripts/router/prove-dispatch-compat.ts). */
  route?: { effort?: string; lane?: string; model?: string }
  /** Route identity (additive-optional): ties this dispatch to its
   *  durable TaskRoutePlan node — the full plan lives in routerRunStore, never
   *  in the mailbox (bounded envelopes). Absent on legacy traffic. */
  routePlan?: { planId: string; nodeId: string; revision: number; attempt: number }
}

export interface EscalateEnvelope extends ScribeEnvelopeBase {
  kind: 'escalate'
  /** Why the Implementer is escalating (blocker / ambiguity / out-of-scope). */
  reason: string
  /** The dispatch request_id this escalation is about, if any. */
  refRequestId?: string
  /** True when the Scribe must take this to the human (operator-level decision). */
  needsOperator?: boolean
}

export interface ProgressEnvelope extends ScribeEnvelopeBase {
  kind: 'progress'
  status: 'started' | 'working' | 'blocked' | 'done' | 'failed'
  detail?: string
  refRequestId?: string
}

export interface ControlEnvelope extends ScribeEnvelopeBase {
  kind: 'control'
  command: 'pause' | 'resume' | 'stop' | 'clear' | 'ack' | 'cancel'
  detail?: string
  refRequestId?: string
}

export interface NoteEnvelope extends ScribeEnvelopeBase {
  /** #47 `/all`: an operator note/broadcast. It is CONTEXT, not a work item — the daemon
   *  delivers it to the Implementer's stdin like a control and it never consumes the
   *  one-dispatch budget. `from` is the operator/team-lead (never 'implementer'). */
  kind: 'note'
  text: string
  /** true ⇒ this is an operator BROADCAST: the operator addressing BOTH agents at once
   *  (via /all), bypassing refine→dispatch. The Scribe ALSO receives it (so it IS in the
   *  loop), both sides labeled OPERATOR_BROADCAST_LABEL; each must read it as shared
   *  context, NOT as work to dispatch/execute. Absent/false ⇒ a plain operator note. */
  broadcast?: boolean
  refRequestId?: string
}

export type ScribeEnvelope =
  | DispatchEnvelope
  | EscalateEnvelope
  | ProgressEnvelope
  | ControlEnvelope
  | NoteEnvelope

function base(kind: ScribeEnvelopeKind, from: string): ScribeEnvelopeBase {
  return {
    type: SCRIBE_PROTOCOL_TYPE,
    kind,
    request_id: generateRequestId(kind, from),
    from,
    timestamp: new Date().toISOString(),
  }
}

// ── builders ────────────────────────────────────────────────────────────────

export function buildDispatch(
  from: string,
  task: string,
  opts?: {
    title?: string
    priority?: 'normal' | 'high'
    refRequestId?: string
    route?: { effort?: string; lane?: string; model?: string }
    routePlan?: { planId: string; nodeId: string; revision: number; attempt: number }
  },
): DispatchEnvelope {
  return {
    ...base('dispatch', from),
    kind: 'dispatch',
    task,
    ...(opts?.title ? { title: opts.title } : {}),
    ...(opts?.priority ? { priority: opts.priority } : {}),
    ...(opts?.refRequestId ? { refRequestId: opts.refRequestId } : {}),
    ...(opts?.route ? { route: opts.route } : {}),
    ...(opts?.routePlan ? { routePlan: opts.routePlan } : {}),
  }
}

export function buildEscalate(
  from: string,
  reason: string,
  opts?: { refRequestId?: string; needsOperator?: boolean },
): EscalateEnvelope {
  return {
    ...base('escalate', from),
    kind: 'escalate',
    reason,
    ...(opts?.refRequestId ? { refRequestId: opts.refRequestId } : {}),
    ...(opts?.needsOperator !== undefined ? { needsOperator: opts.needsOperator } : {}),
  }
}

export function buildProgress(
  from: string,
  status: ProgressEnvelope['status'],
  opts?: { detail?: string; refRequestId?: string },
): ProgressEnvelope {
  return {
    ...base('progress', from),
    kind: 'progress',
    status,
    ...(opts?.detail ? { detail: opts.detail } : {}),
    ...(opts?.refRequestId ? { refRequestId: opts.refRequestId } : {}),
  }
}

export function buildControl(
  from: string,
  command: ControlEnvelope['command'],
  opts?: { detail?: string; refRequestId?: string },
): ControlEnvelope {
  return {
    ...base('control', from),
    kind: 'control',
    command,
    ...(opts?.detail ? { detail: opts.detail } : {}),
    ...(opts?.refRequestId ? { refRequestId: opts.refRequestId } : {}),
  }
}

export function buildNote(
  from: string,
  text: string,
  opts?: { refRequestId?: string; broadcast?: boolean },
): NoteEnvelope {
  // Invariant: a note is the operator/team-lead's voice, NEVER the Implementer's (the
  // daemon delivers it like a control; classifyAuthor attributes it to 'operator' on
  // kind alone). Guard it at the source so a misrouted implementer-authored note can't
  // exist (it would otherwise read as an operator note it never was).
  if (from === 'implementer') {
    throw new Error("buildNote: a note must be from the operator/team-lead, never 'implementer'")
  }
  return {
    ...base('note', from),
    kind: 'note',
    text,
    ...(opts?.broadcast ? { broadcast: true } : {}),
    ...(opts?.refRequestId ? { refRequestId: opts.refRequestId } : {}),
  }
}

/** Serialize an envelope to the message text that rides the mailbox. */
export function serializeScribeEnvelope(env: ScribeEnvelope): string {
  return JSON.stringify(env)
}

/**
 * A plain-string message whose text is (or wraps) a hand-serialized bus-kind
 * payload. The final benchmark run: tanks intermittently passed
 * their dispatch as a JSON STRING (one carried a `}}` typo — impossible from
 * JSON.stringify), the generic DM path journaled it, and the drain discarded
 * non-envelope text — 3 of 8 routed missions silently stalled to their
 * timebox. SendMessage's plain-message path refuses bus-role senders on a
 * match (with re-send guidance); matches `type` OR `kind` so both the
 * bare-payload and full-envelope hand-serializations are caught.
 */
export function looksLikeHandSerializedBusPayload(text: string): boolean {
  const t = text.trimStart()
  if (!t.startsWith('{')) return false
  return /"(type|kind)"\s*:\s*"(dispatch|progress|escalate|control)"/.test(t.slice(0, 600))
}

// ── classifiers ───────────────────────────────────────────────────────────--

const PROGRESS_STATUSES: readonly ProgressEnvelope['status'][] = [
  'started',
  'working',
  'blocked',
  'done',
  'failed',
]
const CONTROL_COMMANDS: readonly ControlEnvelope['command'][] = [
  'pause',
  'resume',
  'stop',
  'clear',
  'ack',
  'cancel',
]

/**
 * Per-kind required-field guard: the base check (type/kind/request_id) only
 * proves an envelope is SOME scribe_protocol message — it does NOT prove the
 * kind's payload is present. Without this, a malformed envelope (e.g. a dispatch
 * with no `task`, or a progress whose `status` is out of the enum) would parse
 * and the bridge would hand the Implementer an `undefined`/garbage stdin frame
 * (buildBackAgentUserFrame reads env.task / env.text / env.status etc.
 * unconditionally). Returns true only when THIS kind's required fields are well-
 * formed, so a malformed envelope is dropped (null) rather than delivered.
 */
function hasRequiredKindFields(parsed: Record<string, unknown>): boolean {
  switch (parsed.kind as ScribeEnvelopeKind) {
    case 'dispatch':
      return typeof parsed.task === 'string'
    case 'escalate':
      return typeof parsed.reason === 'string'
    case 'progress':
      return PROGRESS_STATUSES.includes(parsed.status as ProgressEnvelope['status'])
    case 'control':
      return CONTROL_COMMANDS.includes(parsed.command as ControlEnvelope['command'])
    case 'note':
      return typeof parsed.text === 'string'
    default:
      return false
  }
}

/** Parse a message's text into a typed scribe envelope, or null. */
export function parseScribeEnvelope(messageText: string): ScribeEnvelope | null {
  try {
    const parsed = JSON.parse(messageText) as Record<string, unknown>
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.type === SCRIBE_PROTOCOL_TYPE &&
      typeof parsed.kind === 'string' &&
      SCRIBE_ENVELOPE_KINDS.includes(parsed.kind as ScribeEnvelopeKind) &&
      typeof parsed.request_id === 'string' &&
      // `from` is a REQUIRED sender field (ScribeEnvelopeBase). Without this an
      // anonymous/forged envelope parsed clean and the bridge delivered it with
      // no sender assertion. Here we only require it is present +
      // non-empty; the ROLE check (a dispatch/control/note must NOT be from the
      // implementer) is enforced at the delivery bridge.
      typeof parsed.from === 'string' &&
      parsed.from.length > 0 &&
      hasRequiredKindFields(parsed)
    ) {
      return parsed as unknown as ScribeEnvelope
    }
  } catch {
    // not JSON / not a scribe envelope
  }
  return null
}

/** True iff the message text is any Scribe protocol envelope. */
export function isScribeProtocolMessage(messageText: string): boolean {
  return parseScribeEnvelope(messageText) !== null
}

function ofKind<T extends ScribeEnvelope>(
  messageText: string,
  kind: ScribeEnvelopeKind,
): T | null {
  const env = parseScribeEnvelope(messageText)
  return env && env.kind === kind ? (env as T) : null
}

export function isDispatchEnvelope(messageText: string): DispatchEnvelope | null {
  return ofKind<DispatchEnvelope>(messageText, 'dispatch')
}
export function isEscalateEnvelope(messageText: string): EscalateEnvelope | null {
  return ofKind<EscalateEnvelope>(messageText, 'escalate')
}
export function isProgressEnvelope(messageText: string): ProgressEnvelope | null {
  return ofKind<ProgressEnvelope>(messageText, 'progress')
}
export function isControlEnvelope(messageText: string): ControlEnvelope | null {
  return ofKind<ControlEnvelope>(messageText, 'control')
}
export function isNoteEnvelope(messageText: string): NoteEnvelope | null {
  return ofKind<NoteEnvelope>(messageText, 'note')
}

/**
 * Resolve the VERIFIED sender of a `note` (#47 `/all`) destined for a back-agent's
 * stdin — the from-binding discipline already used for shutdown_request envelopes
 * (resolveShutdownRequestSender). A note is delivered to the leaf as authoritative
 * `[operator note]`/`[operator broadcast]` CONTEXT, so its source must be trustworthy:
 * the only legitimate producer (`/all`) stamps `from` === TEAM_LEAD_NAME on BOTH the
 * mailbox-record envelope AND the in-body envelope (NoteEnvelope.from is documented as
 * "the operator/team-lead, never 'implementer'").
 *
 * @param envelopeFrom the trustworthy mailbox-record sender (TeammateMessage.from), NOT
 *   the spoofable in-body `from`.
 * Returns the verified sender to attribute the note to, or null to IGNORE (drop) it when:
 *   - there is no verified envelope sender (an unsourced note), or
 *   - the in-body `from` disagrees with the envelope sender (a spoof attempt), or
 *   - the note claims to be from the RECEIVING agent itself (a leaf can never be the
 *     operator addressing itself — a bus write is not a self-receipt).
 */
export function resolveNoteSender(
  envelopeFrom: string | undefined,
  note: NoteEnvelope,
  recipientName: string,
): string | null {
  const verified = (envelopeFrom ?? '').trim()
  if (!verified) return null
  const claimed = (note.from ?? '').trim()
  if (claimed && claimed !== verified) return null // in-body from spoofs another agent
  const me = (recipientName ?? '').trim().toLowerCase()
  if (me && verified.toLowerCase() === me) return null // a note "from" the receiver itself
  return verified
}

/**
 * Delivery-liveness read of the Implementer's inbox (trust-cockpit
 * how many scribe_protocol envelopes are QUEUED (written but not
 * yet marked delivered by the daemon's drain) and how old the oldest is.
 * A pure mailbox-file read — deliberately works with NO daemon, because the
 * daemon-deaf bus (the ledgered chokidar subscribe-before-first-write class)
 * is exactly the failure this exposes: dispatches piling up unread while the
 * deck says "in flight". Never throws; an unreadable inbox reads as unknown
 * (null), not as an empty queue.
 */
export async function scribeBusQueueDepth(
  nowMs = Date.now(),
): Promise<{ queued: number; oldestMs: number | null } | null> {
  try {
    const { readUnreadMessages } = await import('../teammateMailbox.js')
    const unread = await readUnreadMessages('implementer', 'scribe')
    const envelopes = unread.filter(m => parseScribeEnvelope(m.text) !== null)
    if (envelopes.length === 0) return { queued: 0, oldestMs: null }
    let oldest: number | null = null
    for (const m of envelopes) {
      const t = Date.parse(m.timestamp)
      if (Number.isFinite(t) && (oldest === null || t < oldest)) oldest = t
    }
    return {
      queued: envelopes.length,
      oldestMs: oldest !== null ? Math.max(0, nowMs - oldest) : null,
    }
  } catch {
    return null
  }
}
