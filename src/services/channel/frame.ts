
import { randomUUID } from 'crypto'
import type { Principal } from '../../substrate/identity/principal.js'

export const FRAME_VERSION = 1

export type { Principal }

export type FrameKind =
  | 'turn.user'
  | 'turn.assistant'
  | 'turn.attachment'
  | 'turn.system'
  | 'chat.human'
  | 'chat.agent'
  | 'presence.join'
  | 'presence.leave'
  | 'presence.heartbeat'
  | 'presence.typing'
  | 'cursor.read'
  | 'claim.acquire'
  | 'claim.release'
  | 'claim.lane'
  | 'work.request'
  | 'work.decision'
  | 'work.status'
  | 'work.compact'
  | 'usage.turn'
  | 'bus.scribe'
  | 'bus.crew'
  | 'sys.snapshot'
  | 'sys.redact'
  | 'sys.room'

const FRAME_KINDS: ReadonlySet<string> = new Set<FrameKind>([
  'turn.user',
  'turn.assistant',
  'turn.attachment',
  'turn.system',
  'chat.human',
  'chat.agent',
  'presence.join',
  'presence.leave',
  'presence.heartbeat',
  'presence.typing',
  'cursor.read',
  'claim.acquire',
  'claim.release',
  'claim.lane',
  'work.request',
  'work.decision',
  'work.status',
  'work.compact',
  'usage.turn',
  'bus.scribe',
  'bus.crew',
  'sys.snapshot',
  'sys.redact',
  'sys.room',
])

export function isFrameKind(value: unknown): value is FrameKind {
  return typeof value === 'string' && FRAME_KINDS.has(value)
}

const FRAME_KIND_SHAPE = /^[a-z][a-z0-9_-]{0,23}\.[a-z][a-z0-9_.-]{0,39}$/

export function isFrameKindShape(value: unknown): value is string {
  return typeof value === 'string' && FRAME_KIND_SHAPE.test(value)
}


const BODY_CAPS: ReadonlyArray<readonly [prefixOrKind: string, maxBytes: number]> = [
  ['chat.', 8 * 1024],
  ['turn.user', 64 * 1024],
  ['turn.', 256 * 1024],
  ['presence.', 1024],
  ['cursor.', 1024],
  ['claim.', 4 * 1024],
  ['work.request', 16 * 1024],
  ['work.', 4 * 1024],
  ['usage.', 1024],
  ['bus.', 256 * 1024],
  ['sys.', 64 * 1024],
]

const BODY_CAP_DEFAULT = 16 * 1024

export function bodyCapForKind(kind: string): number {
  for (const [k, cap] of BODY_CAPS) {
    if (kind === k || (k.endsWith('.') && kind.startsWith(k))) return cap
  }
  return BODY_CAP_DEFAULT
}

export function bodyCapViolation(kind: string, body: unknown): string | null {
  let bytes: number
  try {
    bytes = Buffer.byteLength(JSON.stringify(body) ?? 'null', 'utf-8')
  } catch {
    return `body of ${kind} is not JSON-serializable`
  }
  const cap = bodyCapForKind(kind)
  return bytes > cap
    ? `body of ${kind} is ${bytes} bytes (cap ${cap})`
    : null
}

export interface Frame {
  v: number
  room: string
  seq: number
  hlc: string
  id: string
  author: Principal
  kind: FrameKind
  body: unknown
  refs?: string[]
  sig?: string
  c: string
}

export interface FrameDraft {
  room: string
  author: Principal
  kind: FrameKind
  body: unknown
  refs?: string[]
  sig?: string
}


const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let crc = n
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    }
    table[n] = crc >>> 0
  }
  return table
})()

export function crc32Hex(input: string): string {
  const bytes = Buffer.from(input, 'utf-8')
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8)
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')
}


export function canonicalFrameJson(frame: Omit<Frame, 'c'>): string {
  return JSON.stringify({
    v: frame.v,
    room: frame.room,
    seq: frame.seq,
    hlc: frame.hlc,
    id: frame.id,
    author: {
      id: frame.author.id,
      kind: frame.author.kind,
      ...(frame.author.name !== undefined ? { name: frame.author.name } : {}),
    },
    kind: frame.kind,
    body: frame.body,
    ...(frame.refs !== undefined ? { refs: frame.refs } : {}),
    ...(frame.sig !== undefined ? { sig: frame.sig } : {}),
  })
}

export function sealFrame(
  draft: FrameDraft,
  seal: { seq: number; hlc: string; id?: string },
): Frame {
  const unsealed: Omit<Frame, 'c'> = {
    v: FRAME_VERSION,
    room: draft.room,
    seq: seal.seq,
    hlc: seal.hlc,
    id: seal.id ?? randomUUID(),
    author: draft.author,
    kind: draft.kind,
    body: draft.body,
    ...(draft.refs !== undefined ? { refs: draft.refs } : {}),
    ...(draft.sig !== undefined ? { sig: draft.sig } : {}),
  }
  return { ...unsealed, c: crc32Hex(canonicalFrameJson(unsealed)) }
}

export function encodeFrameLine(frame: Frame): string {
  const { c: _c, ...rest } = frame
  return canonicalFrameJson(rest).slice(0, -1) + `,"c":"${frame.c}"}` + '\n'
}

export type FrameDecodeFailure = 'torn' | 'crc-mismatch' | 'invalid-envelope'

export type FrameDecodeResult =
  | { ok: true; frame: Frame }
  | { ok: false; failure: FrameDecodeFailure; detail?: string }

function isPrincipal(value: unknown): value is Principal {
  if (typeof value !== 'object' || value === null) return false
  const p = value as Record<string, unknown>
  return (
    typeof p.id === 'string' &&
    p.id.length > 0 &&
    (p.kind === 'operator' || p.kind === 'guest' || p.kind === 'agent') &&
    (p.name === undefined || typeof p.name === 'string')
  )
}

export function decodeFrameLine(line: string): FrameDecodeResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { ok: false, failure: 'torn' }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, failure: 'invalid-envelope', detail: 'not an object' }
  }
  const f = parsed as Record<string, unknown>
  if (
    typeof f.v !== 'number' ||
    f.v < 1 ||
    f.v > FRAME_VERSION ||
    typeof f.room !== 'string' ||
    f.room.length === 0 ||
    typeof f.seq !== 'number' ||
    !Number.isInteger(f.seq) ||
    f.seq < 1 ||
    typeof f.hlc !== 'string' ||
    f.hlc.length === 0 ||
    typeof f.id !== 'string' ||
    f.id.length === 0 ||
    !isPrincipal(f.author) ||
    !isFrameKindShape(f.kind) ||
    !('body' in f) ||
    (f.refs !== undefined &&
      !(Array.isArray(f.refs) && f.refs.every(r => typeof r === 'string'))) ||
    (f.sig !== undefined && typeof f.sig !== 'string') ||
    typeof f.c !== 'string'
  ) {
    return { ok: false, failure: 'invalid-envelope' }
  }
  const frame: Frame = {
    v: f.v,
    room: f.room,
    seq: f.seq,
    hlc: f.hlc,
    id: f.id,
    author: f.author as Principal,
    kind: f.kind as FrameKind,
    body: f.body,
    ...(f.refs !== undefined ? { refs: f.refs as string[] } : {}),
    ...(f.sig !== undefined ? { sig: f.sig as string } : {}),
    c: f.c,
  }
  const { c, ...rest } = frame
  const expected = crc32Hex(canonicalFrameJson(rest))
  if (c !== expected) {
    return {
      ok: false,
      failure: 'crc-mismatch',
      detail: `crc ${c} != ${expected} (seq ${frame.seq})`,
    }
  }
  return { ok: true, frame }
}
