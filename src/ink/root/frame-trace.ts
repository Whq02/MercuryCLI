
export interface FrameTraceRow {
  schema: 1
  seq: number
  at: number
  totalMs: number
  yogaMs: number
  commitMs: number
  rendererMs: number
  diffMs: number
  optimizeMs: number
  writeMs: number
  patches: number
  fullClears: number
  lastClearReason: string | null
  inputToFrameMs: number | null
  actionId: string | null
  contexts: string[]
}

export const FRAME_TRACE_RING_CAP = 256
const RING_CAP = FRAME_TRACE_RING_CAP

const ring: FrameTraceRow[] = []
let seq = 0

let pendingInput: { at: number; actionId: string | null; contexts: string[] } | null = null

export function traceKeyResolved(actionId: string | null, contexts: readonly string[]): void {
  pendingInput = { at: performance.now(), actionId, contexts: [...contexts] }
}

export interface FrameTraceInput {
  durationMs: number
  phases?: {
    renderer: number
    diff: number
    optimize: number
    write: number
    patches: number
    yoga: number
    commit: number
  }
  flickers: Array<{ reason: string }>
}

export function recordFrameTrace(ev: FrameTraceInput): void {
  const now = performance.now()
  const input = pendingInput
  pendingInput = null
  const row: FrameTraceRow = {
    schema: 1,
    seq: seq++,
    at: now,
    totalMs: ev.durationMs,
    yogaMs: ev.phases?.yoga ?? 0,
    commitMs: ev.phases?.commit ?? 0,
    rendererMs: ev.phases?.renderer ?? 0,
    diffMs: ev.phases?.diff ?? 0,
    optimizeMs: ev.phases?.optimize ?? 0,
    writeMs: ev.phases?.write ?? 0,
    patches: ev.phases?.patches ?? 0,
    fullClears: ev.flickers.length,
    lastClearReason: ev.flickers.length > 0 ? (ev.flickers[ev.flickers.length - 1]?.reason ?? null) : null,
    inputToFrameMs: input ? now - input.at : null,
    actionId: input?.actionId ?? null,
    contexts: input?.contexts ?? [],
  }
  ring.push(row)
  if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP)
}

export function readFrameTrace(): readonly FrameTraceRow[] {
  return ring
}

export function _resetFrameTraceForTesting(): void {
  ring.length = 0
  seq = 0
  pendingInput = null
}
