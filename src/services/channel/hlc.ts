/**
 * Caduceus hybrid logical clock — cross-writer order the wall clock can't lie about.
 *
 * A room's authoritative order is `seq` (assigned under the append lock). The
 * HLC exists for everything seq can't give: comparing frames ACROSS rooms,
 * merging views from writers whose wall clocks disagree (two machines in a
 * remote room), and keeping causality when a clock steps backwards (NTP slew,
 * VM resume). Classic Kulkarni/Demirbas HLC rules, string-encoded so plain
 * lexicographic comparison IS the happens-after comparison — no parse needed
 * at sort sites.
 *
 * Encoding: `<millis:14 base10>.<counter:4 base36>.<node>`
 *   - 14 digits of millis is good through year 5138 — the pad never overflows.
 *   - counter ticks when two stamps land in the same millisecond (or the wall
 *     clock is behind the observed maximum); 4 base36 digits = 1.6M events per
 *     ms per node before overflow, at which point we ROLL the millis forward
 *     one ms (logical time may lead physical time — that is the HLC contract).
 *   - node breaks the final tie and attributes the stamp (principal-derived).
 */

export interface HlcState {
  /** Highest physical-time component observed (ours or a peer's), ms. */
  wallMs: number
  /** Logical counter within wallMs. */
  counter: number
  /** This writer's node id (short, principal-derived, no dots). */
  node: string
}

const COUNTER_LIMIT = 36 ** 4 // 4 base36 digits

/** A node id must never contain the field separator. */
export function sanitizeHlcNode(node: string): string {
  const cleaned = node.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24)
  return cleaned.length > 0 ? cleaned : 'node'
}

export function createHlcState(node: string, nowMs?: number): HlcState {
  return {
    wallMs: Math.max(0, Math.floor(nowMs ?? Date.now())),
    counter: 0,
    node: sanitizeHlcNode(node),
  }
}

export function encodeHlc(state: HlcState): string {
  return (
    String(state.wallMs).padStart(14, '0') +
    '.' +
    state.counter.toString(36).padStart(4, '0') +
    '.' +
    state.node
  )
}

export interface DecodedHlc {
  wallMs: number
  counter: number
  node: string
}

export function decodeHlc(stamp: string): DecodedHlc | null {
  const firstDot = stamp.indexOf('.')
  const secondDot = stamp.indexOf('.', firstDot + 1)
  if (firstDot !== 14 || secondDot !== 19) return null
  const wallMs = Number(stamp.slice(0, firstDot))
  const counter = parseInt(stamp.slice(firstDot + 1, secondDot), 36)
  const node = stamp.slice(secondDot + 1)
  if (!Number.isFinite(wallMs) || !Number.isFinite(counter) || node.length === 0) {
    return null
  }
  return { wallMs, counter, node }
}

/**
 * Advance the clock for a LOCAL event (we are about to stamp a frame).
 * Mutates and returns the encoded stamp.
 */
export function hlcTick(state: HlcState, nowMs?: number): string {
  const now = Math.max(0, Math.floor(nowMs ?? Date.now()))
  if (now > state.wallMs) {
    state.wallMs = now
    state.counter = 0
  } else {
    state.counter += 1
    if (state.counter >= COUNTER_LIMIT) {
      // Logical time leads physical time rather than ever re-issuing a stamp.
      state.wallMs += 1
      state.counter = 0
    }
  }
  return encodeHlc(state)
}

/**
 * Merge a REMOTE stamp we just observed (received frame), so our next local
 * stamp is guaranteed to sort after it even if our wall clock lags the peer's.
 */
export function hlcObserve(state: HlcState, remoteStamp: string, nowMs?: number): void {
  const remote = decodeHlc(remoteStamp)
  if (!remote) return // an unparseable peer stamp must never wedge the clock
  const now = Math.max(0, Math.floor(nowMs ?? Date.now()))
  if (now > state.wallMs && now > remote.wallMs) {
    state.wallMs = now
    state.counter = 0
    return
  }
  if (remote.wallMs > state.wallMs) {
    state.wallMs = remote.wallMs
    state.counter = remote.counter + 1
  } else if (remote.wallMs === state.wallMs) {
    state.counter = Math.max(state.counter, remote.counter) + 1
  } else {
    state.counter += 1
  }
  if (state.counter >= COUNTER_LIMIT) {
    state.wallMs += 1
    state.counter = 0
  }
}

/** Lexicographic-equals-causal comparison (the encoding's whole point). */
export function compareHlc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Derive a short, dot-free HLC node id from a principal id. */
export function principalNode(principalId: string): string {
  // The id already encodes the kind prefix; keep it dot-free for the HLC field.
  return principalId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'node'
}
