// ============================================================================
//  frame-trace.ts — the frame latency trace: a bounded
//  in-memory ring of render-pipeline timings, so a slow paint is ATTRIBUTED
//  to a stage instead of guessed at.
//
//  SCHEMA-FIRST PRIVACY: the row type is fixed numeric-and-identifier fields
//  only. The action id is Action Graph vocabulary (already public), contexts
//  are the keybinding context names, flicker reasons are the writer's own
//  bounded reason strings. There is no free-text field and no "extras" bag,
//  so message text, file contents, clipboard contents and typed characters
//  are excluded BY CONSTRUCTION — the input seam records the RESOLUTION of a
//  keystroke (an action id or null), never the keystroke itself.
//
//  Feed points (observation only — no behavior change):
//    · the chord interceptor (first React-side receiver of every keystroke)
//      stamps accepted+resolved via traceKeyResolved();
//    · the renderer's onFrame event carries the pipeline phase timings the
//      engine already measures (renderer · diff · optimize · write · yoga ·
//      commit) — recordFrameTrace() files them with input attribution.
// ============================================================================

export interface FrameTraceRow {
  schema: 1
  /** Monotonic per-process frame counter (ring sequence). */
  seq: number
  /** performance.now() when the frame record was filed. */
  at: number
  totalMs: number
  /** Pipeline phases, the engine's own measurements. */
  yogaMs: number
  commitMs: number
  rendererMs: number
  diffMs: number
  optimizeMs: number
  writeMs: number
  patches: number
  /** Full-clear count this frame + the writer's bounded reason id. */
  fullClears: number
  lastClearReason: string | null
  /** Newest keystroke accepted before this frame: resolver-entry → frame
   *  filed, in ms. Null when no key arrived since the previous frame. */
  inputToFrameMs: number | null
  /** The Action Graph id that keystroke resolved to (null = typed/none). */
  actionId: string | null
  /** Keybinding contexts active at resolution — "which surface owned focus"
   *  in the graph's own vocabulary. */
  contexts: string[]
}

// Exported for the trace panel's own window disclosure (FC-133): the ring
// bounds a FRAME COUNT, not a time span — under steady paint traffic the
// window is about a minute, and the panel must say so instead of printing
// a bare n=256.
export const FRAME_TRACE_RING_CAP = 256
const RING_CAP = FRAME_TRACE_RING_CAP

const ring: FrameTraceRow[] = []
let seq = 0

// The newest accepted-and-resolved keystroke awaiting frame attribution.
let pendingInput: { at: number; actionId: string | null; contexts: string[] } | null = null

/** The interceptor's stamp — once per keystroke, identifiers only. */
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

/** File one rendered frame (the renderer's onFrame consumer). */
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
