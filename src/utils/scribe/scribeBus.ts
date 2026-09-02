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
  task: string
  title?: string
  priority?: 'normal' | 'high'
  refRequestId?: string
  route?: { effort?: string; lane?: string; model?: string }
  routePlan?: { planId: string; nodeId: string; revision: number; attempt: number }
}

export interface EscalateEnvelope extends ScribeEnvelopeBase {
  kind: 'escalate'
  reason: string
  refRequestId?: string
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
  kind: 'note'
  text: string
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

export function serializeScribeEnvelope(env: ScribeEnvelope): string {
  return JSON.stringify(env)
}

export function looksLikeHandSerializedBusPayload(text: string): boolean {
  const t = text.trimStart()
  if (!t.startsWith('{')) return false
  return /"(type|kind)"\s*:\s*"(dispatch|progress|escalate|control)"/.test(t.slice(0, 600))
}


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
      typeof parsed.from === 'string' &&
      parsed.from.length > 0 &&
      hasRequiredKindFields(parsed)
    ) {
      return parsed as unknown as ScribeEnvelope
    }
  } catch {
  }
  return null
}

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

export function resolveNoteSender(
  envelopeFrom: string | undefined,
  note: NoteEnvelope,
  recipientName: string,
): string | null {
  const verified = (envelopeFrom ?? '').trim()
  if (!verified) return null
  const claimed = (note.from ?? '').trim()
  if (claimed && claimed !== verified) return null
  const me = (recipientName ?? '').trim().toLowerCase()
  if (me && verified.toLowerCase() === me) return null
  return verified
}

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
