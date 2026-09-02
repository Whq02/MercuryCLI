// ============================================================================
//  LiveStreamingTail — the ONE subscribed leaf that renders the in-flight
//  assistant text.
//
//  Subscribes to the per-REPL StreamingTailStore via useSyncExternalStore:
//  text deltas re-render THIS leaf at the store's bounded cadence (~25fps,
//  boundary flushes immediate) — the REPL tree above never commits per
//  delta or per line. The full text INCLUDING the trailing partial line is
//  passed to StreamingMarkdown, whose monotonic stable-prefix split bounds
//  the per-publish lex to the growing last block.
//
//  Visual contract: byte-identical chrome to the pre-FLUX streaming block —
//  same marginTop Box, same nameplate — only the CADENCE of text appearance
//  changed (recorded
//  intentional change #1, docs/.md).
// ============================================================================

import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useFluxMountMark } from '../hooks/useFluxMountMark.js'
import { Box, Text, flushPendingSyncWork } from '../ink.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { isFullscreenActive } from '../utils/fullscreen.js'
import type { StreamingTailStore } from '../utils/messages/streamingTailStore.js'
import { StreamingMarkdown } from './Markdown.js'
import { MercuryStreamingNameplate } from './messages/ChatLine.js'
import { fluxMark } from '../utils/flux/fluxProbe.js'
import { cockpitEngine } from '../render-engine/cockpit/engineMount.js'
import { useAppState, type AppState } from '../state/AppState.js'
import { declaredRouteOf } from '../services/providers/callModelRouter.js'
import {
  getFocusedSessionConnector,
  subscribeThroughFocused,
} from '../services/engine-connector/focusedConnector.js'

// The quiet-line's model: the FOCUSED chat's connector facts through the
// focused slot — the road MercuryFrame and the helm rail were moved to. The
// tail keyed its placeholder on AppState's mainLoopModelForSession ??
// mainLoopModel, which only LOCAL roads write: a daemon-lane /model switch
// returns before any setAppState, so a session switched to a GPT model
// painted no quiet line, and the composer picker's local patch (AppState
// alone) stood a grey 'thinking' line over an Anthropic turn that would
// never produce one (FN-016 R23). The settled rows key on the row's own
// served model; the live tail now keys on the session's effective model —
// the two agree about which provider the turn belongs to. Module-level:
// the composed subscribe is stable for useSyncExternalStore, and a hop
// re-points it.
const subscribeFocusedTailModel = subscribeThroughFocused((connector, listener) =>
  connector.subscribeModel(listener),
)
const getFocusedTailModel = (): string => getFocusedSessionConnector().modelFacts().effective

/**
 * INLINE mode's live-region bound: the in-flight tail may paint at most
 * ~one viewport of rows. On the main screen, content taller than the
 * viewport CEDES its top rows to terminal scrollback (print-once, frozen
 * forever) — an UNBOUNDED streaming tail therefore froze mid-state prose
 * (still re-wrapping, later collapsed) into scrollback, and the settle's
 * rewrite was print-once-dropped: the operator read the same reply twice.
 * While streaming, only the LAST rows that fit show (a tail, like tail -f);
 * the settled message then paints ONCE, whole, and cedes final. Fullscreen
 * clips inside the alternate screen and keeps the full tail.
 */
/** Scan a discarded prefix for an UNCLOSED code fence: returns the opening
 *  fence's own line (marker + info string, indent dropped) when `prefix`
 *  ends inside a fenced block, else null. Mirrors marked's fence
 *  recognition to the extent the tail needs (FN-016 R22): up to three
 *  leading spaces; three-plus backticks or tildes; a backtick fence's info
 *  string may not itself contain a backtick; the closer is the same
 *  character, at least as long, with nothing else on its line. A
 *  fence-looking line inside an open block is content, never a nested
 *  opener. Pure and uncached — the whole-prefix fold; the tail's own road
 *  is the carried fold (openFenceBefore) over the same per-line law. */
export function openFenceOf(prefix: string): string | null {
  const open = foldFenceRange(prefix, 0, prefix.length, null)
  return open ? open.line : null
}

type OpenFence = { char: string; len: number; line: string }
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/

/** ONE line through the fence ledger: the per-line law, one owner. */
function foldFenceLine(open: OpenFence | null, line: string): OpenFence | null {
  const m = FENCE_LINE.exec(line)
  if (!m) return open
  const marker = m[1]!
  const char = marker[0]!
  const rest = m[2]!
  if (open === null) {
    if (char === '`' && rest.includes('`')) return null
    return { char, len: marker.length, line: line.trimStart() }
  }
  if (char === open.char && marker.length >= open.len && rest.trim() === '') return null
  return open
}

/** A fence line begins with at most three spaces and then ` or ~ — the
 *  cheap pre-check that spares every prose line its slice and its regex. */
function canOpenFence(text: string, from: number, to: number): boolean {
  let i = from
  while (i < to && i - from < 3 && text.charCodeAt(i) === 32) i++
  if (i >= to) return false
  const c = text.charCodeAt(i)
  return c === 96 || c === 126
}

/** Fold the lines of text[from, to) onto `open` — `to` a line start or the
 *  end of the text. Lines are located by indexOf over the text in place,
 *  never by slicing the region and splitting it into a line array; only a
 *  line that can be a fence at all is sliced out and matched. */
function foldFenceRange(text: string, from: number, to: number, open: OpenFence | null): OpenFence | null {
  let at = from
  while (at < to) {
    let end = text.indexOf('\n', at)
    if (end === -1 || end > to) end = to
    fenceFoldCensus.lines++
    if (canOpenFence(text, at, end)) open = foldFenceLine(open, text.slice(at, end))
    at = end + 1
  }
  return open
}

/** Operation census for the parity prover — lines the fold visited, carries
 *  taken, carries dropped. The law is O(delta) per publish, and a count is
 *  the honest instrument for it, never a wall clock. */
export const fenceFoldCensus = { lines: 0, carries: 0, resets: 0 }

/** The fence fold behind boundTailForInline, carried across publishes. The
 *  store republishes the growing reply every ~32 ms and the cut only moves
 *  forward as the reply grows, so the fold over the discarded prefix is
 *  carried: when the new text EXTENDS the last one and the cut did not
 *  retreat, only the lines in [lastCut, cut) fold onto the carried state —
 *  O(delta) per publish, where re-folding the whole prefix was O(reply
 *  length) per tick (quadratic over a long stream, two allocations a tick:
 *  the prefix copy and its line array). Any other shape — a new reply, a
 *  rewrite, a cut that moved back on a resize — drops the carry and folds
 *  from the start: conservative, correct. The cut is always a line start,
 *  so the carried fold equals the whole fold to the byte (the parity
 *  prover holds the whole-prefix shape as its oracle). One carry per
 *  process: the inline tail is the one consumer, and a second tail
 *  alternating texts merely re-folds (correct, uncarried). */
const fenceCarry: { text: string; cut: number; open: OpenFence | null } = { text: '', cut: 0, open: null }

function openFenceBefore(text: string, cut: number): string | null {
  let from = 0
  let open: OpenFence | null = null
  if (cut >= fenceCarry.cut && text.startsWith(fenceCarry.text)) {
    from = fenceCarry.cut
    open = fenceCarry.open
    fenceFoldCensus.carries++
  } else {
    fenceFoldCensus.resets++
  }
  open = foldFenceRange(text, from, cut, open)
  fenceCarry.text = text
  fenceCarry.cut = cut
  fenceCarry.open = open
  return open ? open.line : null
}

export function boundTailForInline(
  text: string,
  rows: number,
  columns: number,
): { text: string; truncated: boolean; openFence: string | null } {
  const capRows = Math.max(4, rows - 6)
  const width = Math.max(20, columns - 4)
  // Backward scan from the end: only the rows that can fit are ever
  // measured, and the kept region is ONE slice — where splitting the whole
  // growing answer allocated every line on every publish (~25fps) to keep
  // roughly a viewport of them. Same row arithmetic, same overshoot, same
  // outputs to the byte (the parity prover carries the split shape as its
  // oracle). Exported for that prover; the component is the one product
  // consumer.
  let used = 0
  let end = text.length // exclusive end of the line being measured
  let cut = text.length // start index of the kept region
  let linesRemain = true // a line exists at/before `end` (an EMPTY first line counts)
  while (linesRemain && used < capRows) {
    // end === 0 means the remaining line is the empty FIRST line; a bare
    // lastIndexOf at -1 would wrongly re-find a newline at index 0.
    const nl = end === 0 ? -1 : text.lastIndexOf('\n', end - 1)
    const lineStart = nl + 1
    used += Math.max(1, Math.ceil((end - lineStart) / width))
    cut = lineStart
    if (nl === -1) linesRemain = false
    else end = nl
  }
  if (!linesRemain) return { text, truncated: false, openFence: null }
  // The cut is a raw line boundary: when it lands INSIDE a fenced code
  // block, the kept slice would lex as prose (leading # as headings, - as
  // bullets, * as emphasis) until settle re-parses the whole message —
  // two dresses for one text (FN-016 R22). Carry the enclosing block
  // state: the discarded prefix's standing opener rides out for the
  // renderer to prepend, so the tail's dress matches the settled render.
  // The kept TEXT itself stays byte-identical (the parity oracle's pin).
  // The fold is carried between publishes (openFenceBefore): only the
  // lines the cut advanced over since the last tick are folded, never the
  // whole prefix again.
  return { text: text.slice(cut), truncated: true, openFence: openFenceBefore(text, cut) }
}

/** The settle ghost's backstop past the turn's falling edge (FN-016 R24):
 *  the hold releases on its row landing; when no row ever matches, this
 *  bounds how long the ghost may outlive its turn — long enough for the
 *  transcript feed's tick (a 400 ms heartbeat, then a re-read of the whole
 *  log; longer on a slow disk with a long transcript), short enough that
 *  an unmatched settle never stands indefinitely. */
export const SETTLE_LINGER_MS = 2000

/** The text half's snapshot on a SUPPRESSED surface: the quiet↔text phase
 *  alone — null while the stream is quiet, this mark while text flows — so
 *  the store's per-delta publishes never re-render the leaf there. */
const TEXT_FLOWING = 'text-flowing'

export function LiveStreamingTail({
  store,
  settledShown = false,
  publishedShown = false,
  textSuppressed = false,
}: {
  store: StreamingTailStore
  /** The reveal is suppressed on this surface (streamingRevealSuppressed:
   *  reduced motion, or the conhost cursor-up hazard on the main screen) —
   *  the TEXT half never paints here, and neither does the settle ghost;
   *  the leaf still mounts for the ONE quiet-stream 'thinking' line, which
   *  the settled rows suppress on every surface (Message.tsx). Un-mounted
   *  under suppression, a GPT turn's quiet stretch painted NOTHING on such
   *  a surface: the expander withheld and its replacement line never
   *  mounted (FN-016 R12) — the two halves of one feature share one gate. */
  textSuppressed?: boolean
  /** The rendered transcript already shows the reply the tail's last clear
   *  retired (Messages computes it through computeTailRelease — by the
   *  tail's message identity where one rides, by the trimmed text match
   *  otherwise). Until then the tail keeps painting that text IN PLACE as
   *  the settle ghost: the swap from tail to settled row is
   *  growth-in-place, never a shrink — a shrink below the writer's ceded
   *  boundary on the main screen re-pushes frozen rows into scrollback
   *  (the ×2…×6 inline duplication), and the cockpit blinks. The
   *  transcript lags the store by a render whenever REPL hands Messages
   *  its deferred copy at the settle. */
  settledShown?: boolean
  /** The rendered transcript shows the row of the message the PUBLISHED
   *  (non-null) tail belongs to — the settle-class hold the seat keeps in
   *  the projection until the turn's result. The row owns the paint from
   *  the moment it exists: painting the hold beside it was the
   *  attach-road double (the naked caret-bearing copy under the settled
   *  row). Only ever true on an identity match (computeTailRelease) — live
   *  streaming text has no landed row and keeps painting. Fresh at every
   *  boundary: Messages re-renders on the store's boundary transitions. */
  publishedShown?: boolean
}): React.ReactNode {
  fluxMark('render:tail')
  // COCKPIT S1b: tail mount observation (probe-armed only).
  useFluxMountMark('tail')
  // Latency-classed subscription: flush the sync-lane commit as soon as the
  // store notifies, exactly like the input dispatch path does for
  // keystrokes. Left to the scheduler, a publish's commit could slip a full
  // frame window behind the paint throttle — measured as the ~80-120ms
  // visual quantization the ux-parity study called our streamed-text
  // stutter (two 40ms cadences beating).
  const subscribe = useCallback(
    (cb: () => void) =>
      store.subscribe(() => {
        cb()
        // Text publishes flush now; the CLEAR (text → null) does not. The
        // settle fan-out clears the tail and appends the settled message in
        // one call, and a forced flush here committed the tail's unmount
        // ALONE, one frame ahead of the append: the cockpit blinked (the
        // tail clears in one unit, the row paints in the next), and on the
        // main screen the frame SHRANK below the writer's flush line — an
        // epoch that rewinds the ceded boundary — so the append's regrowth
        // pushed already-frozen rows into scrollback a second time (one copy
        // of the block above the tall reply per settle: the ×2…×6 inline
        // duplication). Left to the batch, the clear and the append commit
        // as ONE frame: pure growth, print-once intact, no blink.
        // A suppressed surface paints no text: nothing to flush ahead.
        if (!textSuppressed && store.read() !== null) flushPendingSyncWork()
      }),
    [store, textSuppressed],
  )
  const readPhase = useCallback(
    () => (store.getSnapshot() === null ? null : TEXT_FLOWING),
    [store],
  )
  const published = useSyncExternalStore(subscribe, textSuppressed ? readPhase : store.getSnapshot)
  const { rows, columns } = useTerminalSize()
  const turnActive = useAppState((s: AppState) => s.foregroundTurnActive)
  // The settle ghost: the retired text stands in until the transcript shows
  // the reply, or — past the turn's end — until a bounded linger runs out
  // (a settle whose row never matches must not stand indefinitely).
  // Published text hides the moment its own row is visible (publishedShown
  // — the settle-class hold's release); the ghost machinery is idle while
  // published stands. A suppressed surface has no text half at all: no
  // ghost, no hold (R12).
  const settled = !textSuppressed && published === null ? store.readSettled() : null
  // THE LINGER (FN-016 R24): released on the turn's end alone, a plain
  // single-block reply dropped off the screen for a beat after the model
  // stopped and reappeared with its nameplate — the clear that makes the
  // ghost is itself driven by the turn going idle, while the row it
  // bridges to lands only on the transcript feed's next tick (a heartbeat,
  // then a re-read of the whole log). The row landing stays the release;
  // the budget is the backstop, armed at the turn's falling edge with the
  // hold standing and its row not yet shown.
  const [lingerExpired, setLingerExpired] = useState(false)
  useEffect(() => {
    if (settled === null) {
      setLingerExpired(false)
      return
    }
    if (settledShown || turnActive) return
    const timer = setTimeout(() => setLingerExpired(true), SETTLE_LINGER_MS)
    return () => clearTimeout(timer)
  }, [settled, settledShown, turnActive])
  const ghost = settled !== null && !settledShown && (turnActive || !lingerExpired)
  const rawText = textSuppressed
    ? null
    : ((publishedShown ? null : published) ?? (ghost ? settled : null))
  useEffect(() => {
    if (settled !== null && (settledShown || (!turnActive && lingerExpired))) store.dropSettled()
  }, [store, settled, settledShown, turnActive, lingerExpired])
  // The engine's stream-body cache (spec 02, engine-mounted only): the same
  // markdown-safe boundary the renderer below uses advances the engine's
  // O(delta) row cache. Monotonic — a double render lands on the same
  // boundary (the exact property the boundary ref below relies on).
  const engine = cockpitEngine()
  if (engine && rawText) engine.streamBody.update(rawText, Math.max(20, columns - 4))
  const bounded =
    rawText && !isFullscreenActive()
      ? boundTailForInline(rawText, rows, columns)
      : { text: rawText, truncated: false, openFence: null }
  // A cut that opened inside a fence re-enters it synthetically (R22): the
  // prepended opener line keeps the streaming dress identical to the
  // settled render — code stays code while the fence's head is above-fold.
  const text =
    bounded.truncated && bounded.openFence && bounded.text
      ? `${bounded.openFence}\n${bounded.text}`
      : bounded.text
  // Item D:
  // a GPT turn's in-chat thinking expander is absent — while the OpenAI
  // stream is QUIET (turn live, no text streamed yet) the tail shows ONE
  // plain grayed 'thinking' line, nothing fancier; it vanishes the moment
  // prose streams, and Claude turns are untouched. The route is the
  // focused session's own effective model (R23), never a process-global.
  const liveModel = useSyncExternalStore(
    subscribeFocusedTailModel,
    getFocusedTailModel,
    getFocusedTailModel,
  )
  if (!text) {
    // On a suppressed surface the line stands only while the stream is
    // QUIET: once text flows unseen there, the verb row is the feedback
    // (showSpinner carries the suppression term) — a 'thinking' line over
    // flowing prose would lie.
    const quiet = !textSuppressed || published === null
    if (turnActive && quiet && declaredRouteOf(liveModel) === 'openai') {
      return (
        <Box marginTop={1} width="100%">
          <Text dimColor>thinking</Text>
        </Box>
      )
    }
    return null
  }
  return (
    <Box marginTop={1} width="100%" flexDirection="column">
      {bounded.truncated ? (
        <Text dimColor>… the reply continues above-fold at settle</Text>
      ) : null}
      <StreamingMarkdown leadingInline={<MercuryStreamingNameplate />}>
        {text}
      </StreamingMarkdown>
    </Box>
  )
}
