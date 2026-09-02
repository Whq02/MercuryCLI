
export interface HlcState {
  wallMs: number
  counter: number
  node: string
}

const COUNTER_LIMIT = 36 ** 4

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

export function hlcTick(state: HlcState, nowMs?: number): string {
  const now = Math.max(0, Math.floor(nowMs ?? Date.now()))
  if (now > state.wallMs) {
    state.wallMs = now
    state.counter = 0
  } else {
    state.counter += 1
    if (state.counter >= COUNTER_LIMIT) {
      state.wallMs += 1
      state.counter = 0
    }
  }
  return encodeHlc(state)
}

export function hlcObserve(state: HlcState, remoteStamp: string, nowMs?: number): void {
  const remote = decodeHlc(remoteStamp)
  if (!remote) return
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

export function compareHlc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function principalNode(principalId: string): string {
  return principalId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'node'
}
