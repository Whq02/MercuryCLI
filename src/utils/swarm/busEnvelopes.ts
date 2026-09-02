/**
 * busEnvelopes — the typed coordination envelopes that ride the EXISTING file
 * teammate-mailbox bus between a dispatcher (the operator's session, the
 * daemon) and a daemon-hosted worker (a crew teammate). Modeled on
 * teammateMailbox.ts's create/is helpers: each builder returns a
 * JSON-serializable envelope tagged with the bus protocol type, a `kind`
 * sub-discriminator and a `request_id` (reusing generateRequestId), and each
 * classifier parses a message's text back into the typed envelope (or null).
 *
 * The outer `type` keeps these DISTINCT from the existing teammate protocol
 * types (isStructuredProtocolMessage checks its own closed list and never
 * matches these), so the two protocols coexist on one mailbox. The feature
 * gate (busEnvelopesEnabled) is applied at the call sites (SendMessage + the
 * inbox demux) — these builders/classifiers are pure.
 *
 * Five kinds:
 *   - dispatch  dispatcher → worker: a refined, well-specified task to execute.
 *   - escalate  worker → dispatcher: a blocker / ambiguity / out-of-scope ask.
 *   - progress  worker → dispatcher: a status heartbeat (started/working/…).
 *   - control   either direction: pause/resume/stop/clear/ack/cancel of the work.
 *   - note      dispatcher → worker: operator context, never a work item.
 */
import { generateRequestId } from '../agentId.js'
import { flagEnabled } from '../../substrate/flagRegistry.js'

/** The wire discriminator every envelope carries. Writers emit the neutral
 *  spelling; the decoder also accepts the retired spelling, because inbox
 *  files persisted before the rename still carry it. */
export const BUS_PROTOCOL_TYPE = 'bus_protocol' as const
/** The retired protocol spelling — READ only (persisted envelopes), never
 *  written. */
export const LEGACY_BUS_PROTOCOL_TYPE = 'scribe_protocol' as const

export type BusEnvelopeKind = 'dispatch' | 'escalate' | 'progress' | 'control' | 'note'

export const BUS_ENVELOPE_KINDS: readonly BusEnvelopeKind[] = [
  'dispatch',
  'escalate',
  'progress',
  'control',
  'note',
]

/** The envelope format gate: OFF (`=0`) ⇒ no bus section in the SendMessage
 *  doctrine, no bus variants in its schema, no envelope demux in the inbox
 *  poller — byte-identical to a build without the bus. */
export function busEnvelopesEnabled(): boolean {
  return flagEnabled('MERCURY_DAEMON_BUS')
}

/** The SINGLE source of truth for the operator-note labels both delivery
 *  sites (a command's stdout and a worker's stdin frame) render, so the
 *  marker can never drift between where it is emitted and where a worker is
 *  told to recognize it. A broadcast note renders OPERATOR_BROADCAST_LABEL;
 *  a plain note renders OPERATOR_NOTE_LABEL. */
export const OPERATOR_BROADCAST_LABEL = '[operator broadcast]'
export const OPERATOR_NOTE_LABEL = '[operator note]'

interface BusEnvelopeBase {
  type: typeof BUS_PROTOCOL_TYPE | typeof LEGACY_BUS_PROTOCOL_TYPE
  kind: BusEnvelopeKind
  request_id: string
  from: string
  timestamp: string
}

export interface DispatchEnvelope extends BusEnvelopeBase {
  kind: 'dispatch'
  /** The refined, well-specified task the worker should execute. */
  task: string
  title?: string
  priority?: 'normal' | 'high'
  /** SUPERSEDES an earlier dispatch (its request_id): the drain drops that earlier
   *  dispatch if it is still queued (unread, not yet delivered) so a correction never
   *  stacks behind the work it replaces. An already-in-flight target can't be un-delivered
   *  (a stream-json turn isn't interruptible mid-frame) — it completes. */
  refRequestId?: string
  /** Per-task routing hint carried for the dispatcher's record: the effort
   *  and lane it judged for THIS task, and the resolved model when a route
   *  plan assigned one. Additive-optional; decoders are total. */
  route?: { effort?: string; lane?: string; model?: string }
  /** Route identity (additive-optional): ties this dispatch to its
   *  durable TaskRoutePlan node — the full plan lives in routerRunStore, never
   *  in the mailbox (bounded envelopes). */
  routePlan?: { planId: string; nodeId: string; revision: number; attempt: number }
}

export interface EscalateEnvelope extends BusEnvelopeBase {
  kind: 'escalate'
  /** Why the worker is escalating (blocker / ambiguity / out-of-scope). */
  reason: string
  /** The dispatch request_id this escalation is about, if any. */
  refRequestId?: string
  /** True when the dispatcher must take this to the human (operator-level decision). */
  needsOperator?: boolean
}

export interface ProgressEnvelope extends BusEnvelopeBase {
  kind: 'progress'
  status: 'started' | 'working' | 'blocked' | 'done' | 'failed'
  detail?: string
  refRequestId?: string
}

export interface ControlEnvelope extends BusEnvelopeBase {
  kind: 'control'
  command: 'pause' | 'resume' | 'stop' | 'clear' | 'ack' | 'cancel'
  detail?: string
  refRequestId?: string
}

export interface NoteEnvelope extends BusEnvelopeBase {
  /** An operator note/broadcast. It is CONTEXT, not a work item — the daemon
   *  delivers it to the worker's stdin like a control and it never consumes the
   *  one-dispatch budget. `from` is the operator/team-lead or the daemon, never
   *  the receiving worker. */
  kind: 'note'
  text: string
  /** true ⇒ an operator BROADCAST addressing every agent at once, labeled
   *  OPERATOR_BROADCAST_LABEL; each reader treats it as shared context, NOT as
   *  work to dispatch/execute. Absent/false ⇒ a plain operator note. */
  broadcast?: boolean
  refRequestId?: string
}

export type BusEnvelope =
  | DispatchEnvelope
  | EscalateEnvelope
  | ProgressEnvelope
  | ControlEnvelope
  | NoteEnvelope

function base(kind: BusEnvelopeKind, from: string): BusEnvelopeBase {
  return {
    type: BUS_PROTOCOL_TYPE,
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
  // Invariant: a note is the operator's, the team-lead's or the daemon's
  // voice — it must name its author (the drain refuses a note that claims
  // to come from its own recipient). Guard the empty sender at the source so
  // an unsourced note can't exist.
  if (!from.trim()) {
    throw new Error('buildNote: a note must name its sender (the operator, the team-lead or the daemon)')
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
export function serializeBusEnvelope(env: BusEnvelope): string {
  return JSON.stringify(env)
}

/**
 * A plain-string message whose text is (or wraps) a hand-serialized bus-kind
 * payload. A worker that passes its dispatch as a JSON STRING lands on the
 * generic DM path, the drain discards non-envelope text, and the work stalls
 * silently. SendMessage's plain-message path refuses bus-role senders on a
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
 * proves an envelope is SOME bus message — it does NOT prove the kind's
 * payload is present. Without this, a malformed envelope (e.g. a dispatch
 * with no `task`, or a progress whose `status` is out of the enum) would
 * parse and the drain would hand the worker an `undefined`/garbage stdin
 * frame (buildBackAgentUserFrame reads env.task / env.text / env.status
 * unconditionally). Returns true only when THIS kind's required fields are
 * well-formed, so a malformed envelope is dropped (null) rather than
 * delivered.
 */
function hasRequiredKindFields(parsed: Record<string, unknown>): boolean {
  switch (parsed.kind as BusEnvelopeKind) {
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

/** Parse a message's text into a typed bus envelope, or null. */
export function parseBusEnvelope(messageText: string): BusEnvelope | null {
  try {
    const parsed = JSON.parse(messageText) as Record<string, unknown>
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed.type === BUS_PROTOCOL_TYPE || parsed.type === LEGACY_BUS_PROTOCOL_TYPE) &&
      typeof parsed.kind === 'string' &&
      BUS_ENVELOPE_KINDS.includes(parsed.kind as BusEnvelopeKind) &&
      typeof parsed.request_id === 'string' &&
      // `from` is a REQUIRED sender field. Without this an anonymous/forged
      // envelope parsed clean and the drain delivered it with no sender
      // assertion. Here we only require it is present + non-empty; the ROLE
      // check (work and directives must not be self-authored by the
      // recipient) is enforced at the delivery drain.
      typeof parsed.from === 'string' &&
      parsed.from.length > 0 &&
      hasRequiredKindFields(parsed)
    ) {
      return parsed as unknown as BusEnvelope
    }
  } catch {
    // not JSON / not a bus envelope
  }
  return null
}

/** True iff the message text is any bus protocol envelope. */
export function isBusProtocolMessage(messageText: string): boolean {
  return parseBusEnvelope(messageText) !== null
}

function ofKind<T extends BusEnvelope>(
  messageText: string,
  kind: BusEnvelopeKind,
): T | null {
  const env = parseBusEnvelope(messageText)
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
 * Resolve the VERIFIED sender of a `note` destined for a worker's stdin —
 * the from-binding discipline already used for shutdown_request envelopes
 * (resolveShutdownRequestSender). A note is delivered to the worker as
 * authoritative `[operator note]`/`[operator broadcast]` CONTEXT, so its
 * source must be trustworthy: the legitimate producers stamp `from` on BOTH
 * the mailbox-record envelope AND the in-body envelope.
 *
 * @param envelopeFrom the trustworthy mailbox-record sender (TeammateMessage.from), NOT
 *   the spoofable in-body `from`.
 * Returns the verified sender to attribute the note to, or null to IGNORE (drop) it when:
 *   - there is no verified envelope sender (an unsourced note), or
 *   - the in-body `from` disagrees with the envelope sender (a spoof attempt), or
 *   - the note claims to be from the RECEIVING agent itself (a worker can never be the
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
