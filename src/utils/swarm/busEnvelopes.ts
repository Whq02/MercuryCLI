import { generateRequestId } from '../agentId.js'
import { flagEnabled } from '../../substrate/flagRegistry.js'

export const BUS_PROTOCOL_TYPE = 'scribe_protocol' as const

export type BusEnvelopeKind = 'dispatch' | 'escalate' | 'progress' | 'control' | 'note'

export const BUS_ENVELOPE_KINDS: readonly BusEnvelopeKind[] = [
  'dispatch',
  'escalate',
  'progress',
  'control',
  'note',
]

export function busEnvelopesEnabled(): boolean {
  return flagEnabled('MERCURY_SCRIBE_BUS')
}

export const OPERATOR_BROADCAST_LABEL = '[operator broadcast]'
export const OPERATOR_NOTE_LABEL = '[operator note]'

interface BusEnvelopeBase {
  type: typeof BUS_PROTOCOL_TYPE
  kind: BusEnvelopeKind
  request_id: string
  from: string
  timestamp: string
}

export interface DispatchEnvelope extends BusEnvelopeBase {
  kind: 'dispatch'
  task: string
  title?: string
  priority?: 'normal' | 'high'
  refRequestId?: string
  route?: { effort?: string; lane?: string; model?: string }
  routePlan?: { planId: string; nodeId: string; revision: number; attempt: number }
}

export interface EscalateEnvelope extends BusEnvelopeBase {
  kind: 'escalate'
  reason: string
  refRequestId?: string
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
  kind: 'note'
  text: string
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

export function serializeBusEnvelope(env: BusEnvelope): string {
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

export function parseBusEnvelope(messageText: string): BusEnvelope | null {
  try {
    const parsed = JSON.parse(messageText) as Record<string, unknown>
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.type === BUS_PROTOCOL_TYPE &&
      typeof parsed.kind === 'string' &&
      BUS_ENVELOPE_KINDS.includes(parsed.kind as BusEnvelopeKind) &&
      typeof parsed.request_id === 'string' &&
      typeof parsed.from === 'string' &&
      parsed.from.length > 0 &&
      hasRequiredKindFields(parsed)
    ) {
      return parsed as unknown as BusEnvelope
    }
  } catch {
  }
  return null
}

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
