/**
 * Caduceus frame — the ONE wire-and-storage envelope of Mercury's session fabric.
 *
 * A room (a session, a party lane, a crew chat) is an append-only log of FRAMES.
 * Everything that happens in a collaborative context — a human chat line, an
 * assistant turn, a bus dispatch, a presence heartbeat, a work claim — is a frame
 * with the same envelope, so ordering, attribution, replay, and integrity are
 * solved once, here, instead of per-subsystem (transcript JSONL + three file
 * buses + a roster file, each with its own ad-hoc envelope).
 *
 * Design invariants (the proof suite in scripts/channel/ holds each):
 *   1. ONE LINE = ONE FRAME — NDJSON. JSON.stringify never emits raw newlines,
 *      so line-completeness ≈ frame-completeness; a torn tail line fails parse
 *      and is recoverable by scan-back (log.ts owns that).
 *   2. INTEGRITY IS IN-BAND — every line carries `c`, a CRC32 over the frame's
 *      canonical JSON (the envelope minus `c`). Catches bit-rot and interleaved
 *      writes from an unserialized writer, which can compose parseable garbage
 *      that plain JSON.parse would accept.
 *   3. ATTRIBUTION IS MANDATORY — no frame without an author Principal. The
 *      two-user layer (consent provenance, peer rendering) reads it; agents are
 *      principals too, so cross-user agent chat needs nothing extra.
 *   4. ORDER IS TWO-LAYER — `seq` is the room-authoritative contiguous index
 *      (assigned under the room append lock); `hlc` is a hybrid-logical-clock
 *      stamp that stays comparable ACROSS rooms and across writers whose wall
 *      clocks disagree (hlc.ts owns the update rules).
 *   5. BODIES ARE OPAQUE HERE — kind-specific payload contracts live with their
 *      producers (transcript/, the bus adapters); the core validates the
 *      envelope, never the body. That keeps the fabric dependency-free and the
 *      body schema evolvable without a fabric version bump.
 */

import { randomUUID } from 'crypto'
import type { Principal } from '../../substrate/identity/principal.js'

/** Frame schema version. Bump ONLY on an envelope-shape change; body evolution
 *  never bumps it (invariant 5). Readers accept `v <= FRAME_VERSION`. */
export const FRAME_VERSION = 1

/** Who wrote a frame — the substrate's Principal (identity owns the shape;
 *  `kind` is load-bearing for the ACL in room.ts and for rendering). */
export type { Principal }

/**
 * The closed set of envelope kinds. Dotted namespaces group them:
 *   turn.*     — the session transcript (W4 sessions-as-rooms)
 *   chat.*     — peer chat between humans/agents (the two-user layer)
 *   presence.* — join/leave/heartbeat/typing (ephemeral by retention policy)
 *   cursor.*   — per-principal read cursors (generalizes per-chat unread)
 *   claim.*    — work claims for simultaneous orchestration
 *   work.*     — the delegation queue (multi-operator): a member REQUESTS work,
 *                the owner DECIDES (approve/deny + priority — usage is the
 *                owner's budget), the harness reports STATUS
 *   usage.*    — metered spend (multi-operator budgets): the harness writes a
 *                usage.turn per delegated batch, attributing the turn's cost
 *                delta to the initiating principal (budgets.ts folds them)
 *   bus.*      — the scribe/crew adapter envelopes (semantics preserved
 *                verbatim from the legacy buses, incl. the literal
 *                `[request_id: …]` trailer contract)
 *   sys.*      — fabric bookkeeping (snapshot markers, redaction tombstones)
 */
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

/**
 * FORWARD-COMPAT kind acceptance (multi-build multiplayer): a frame whose kind
 * is not in this build's closed set but IS a well-formed dotted namespace
 * (`ns.verb`) decodes fine — every consumer default-ignores kinds it doesn't
 * know, and the ACL fail-closes on them for non-owners. Without this, a NEWER
 * build's frame kind turns an OLDER build's room open into a hard
 * `invalid-envelope` corruption throw — a rollback/mixed-version landmine the
 * fabric must not have. CRC still guards the bytes; only the membership test
 * is relaxed to a shape test.
 */
const FRAME_KIND_SHAPE = /^[a-z][a-z0-9_-]{0,23}\.[a-z][a-z0-9_.-]{0,39}$/

export function isFrameKindShape(value: unknown): value is string {
  return typeof value === 'string' && FRAME_KIND_SHAPE.test(value)
}

// ---------------------------------------------------------------------------
// Per-kind body caps — the write-side flood guard.
// ---------------------------------------------------------------------------

/**
 * Serialized body byte ceilings, by kind namespace (specific kind overrides
 * first). These are WRITE-side validation, enforced at the append gate
 * (client.ts) for every writer — local and remote alike — so a chat line can't
 * smuggle a megabyte into every reader's per-turn context, and a remote guest
 * can't balloon the room log. Reads are uncapped (history is history).
 * Ceilings are generous for their use, not tight: a pasted stack trace fits in
 * a chat line; a book does not.
 */
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

/** Default cap for kinds no rule names (incl. forward-compat unknown kinds). */
const BODY_CAP_DEFAULT = 16 * 1024

export function bodyCapForKind(kind: string): number {
  for (const [k, cap] of BODY_CAPS) {
    if (kind === k || (k.endsWith('.') && kind.startsWith(k))) return cap
  }
  return BODY_CAP_DEFAULT
}

/**
 * Validate a body against its kind's cap. Returns null when fine, else a
 * human-readable violation. A body that fails to serialize is a violation too
 * (the log stores canonical JSON — an unserializable body can never be sealed).
 */
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

/** A fully-sealed frame as it lives on disk / on the wire. */
export interface Frame {
  /** Envelope schema version (see FRAME_VERSION). */
  v: number
  /** Room id this frame belongs to (redundant with the file location on disk,
   *  load-bearing on the wire and in cross-room refs). */
  room: string
  /** Room-authoritative contiguous sequence (1-based). Assigned by the append
   *  gate under the room lock — never by the producer. */
  seq: number
  /** Hybrid-logical-clock stamp, lexicographically sortable (hlc.ts). */
  hlc: string
  /** Frame identity for refs/dedup — a UUID minted at seal time. */
  id: string
  /** Mandatory author (invariant 3). */
  author: Principal
  kind: FrameKind
  /** Kind-specific payload — opaque to the fabric core (invariant 5). */
  body: unknown
  /** Lineage refs to prior frame ids (cross-seat refs are LINEAGE, never
   *  supersession). */
  refs?: string[]
  /** HMAC-SHA256 (hex) over the canonical bytes, for remote-originated frames.
   *  Local unix-socket writers omit it; the remote listener REQUIRES it. */
  sig?: string
  /** CRC32 (unsigned, hex) over the canonical JSON minus `c` (invariant 2). */
  c: string
}

/** What a producer supplies; the append gate seals the rest (seq/hlc/id/c). */
export interface FrameDraft {
  room: string
  author: Principal
  kind: FrameKind
  body: unknown
  refs?: string[]
  sig?: string
}

// ---------------------------------------------------------------------------
// CRC32 (IEEE 802.3 polynomial) — dependency-free, table-based. In-band frame
// integrity is a fabric contract, so the implementation lives with the frame.
// ---------------------------------------------------------------------------

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

/** CRC32 of a UTF-8 string, as 8-char lowercase hex. */
export function crc32Hex(input: string): string {
  const bytes = Buffer.from(input, 'utf-8')
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8)
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')
}

// ---------------------------------------------------------------------------
// Canonical encoding — the byte layout CRC and HMAC are computed over.
// ---------------------------------------------------------------------------

/**
 * Canonical JSON of a frame WITHOUT its `c` field: fixed key order, no
 * whitespace. Both the CRC (storage integrity) and the HMAC (remote
 * authenticity, principal.ts) are computed over exactly these bytes, so the
 * two verifications can never disagree about what was signed. `sig` IS part
 * of the canonical bytes (it is authenticated data for the CRC; the HMAC is
 * computed over the canonical bytes WITH `sig` ABSENT — see principal.ts).
 */
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

/** Seal a draft into a Frame: stamp seq/hlc/id, compute the CRC. */
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

/**
 * One NDJSON line for a sealed frame (trailing newline included).
 * `c` is SPLICED onto the canonical string rather than re-stringified, so the
 * stored bytes-minus-c are byte-identical to canonicalFrameJson(rest) — CRC
 * verification can never diverge on key order between encode paths.
 */
export function encodeFrameLine(frame: Frame): string {
  const { c: _c, ...rest } = frame
  return canonicalFrameJson(rest).slice(0, -1) + `,"c":"${frame.c}"}` + '\n'
}

/** Why a line failed to decode — `torn` is the ONLY recoverable class at the
 *  log tail; everything else is a hard integrity signal (log.ts decides). */
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

/**
 * Decode one stored line into a verified Frame.
 * A parse failure is `torn` (the recoverable tail class); a parsed-but-wrong
 * shape is `invalid-envelope`; a shape-valid line whose CRC disagrees is
 * `crc-mismatch`. Callers at the TAIL may truncate on `torn`; a mid-log
 * failure of ANY class is corruption and must surface, never be skipped.
 *
 * Kind membership is deliberately a SHAPE test (isFrameKindShape), not a
 * closed-set test: an unknown-but-well-formed kind from a newer build decodes
 * (typed as FrameKind for the consumers, all of which default-ignore unknown
 * kinds); only a malformed kind is an invalid envelope.
 */
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
