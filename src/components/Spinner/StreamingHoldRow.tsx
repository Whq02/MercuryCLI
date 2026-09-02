import * as React from 'react'
import { useRef } from 'react'
import { Box, Text, useAnimationValue } from '../../ink.js'
import { formatDuration } from '../../utils/format.js'
import { WorkingGlyph } from '../mercury-ui/LiveGlyphs.js'
import { WORK_TICK_MS } from '../../utils/cockpit/liveGlyphs.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { MID_STREAM_STILL_WAITING_MS } from './useStalledAnimation.js'

// ============================================================================
//  StreamingHoldRow — the working-strip's TRUTH-tier hold while the verb row
//  yields to streaming prose.
//
//  The verb/shimmer row hides while streaming text is visible (the prose IS
//  the focal feedback — REPL's showSpinner), but the slot it reserved used
//  to hold a BLANK row: the dressed WorkCapsule rendered as an EMPTY
//  bordered card beside the critter (the S7 "empty bubble"), the elapsed
//  timer vanished mid-turn and reappeared on the next tool call, and a
//  STALLED stream showed no working signal at all — a hung turn read as
//  idle.
//
//  This row keeps the slot honest at minimal voice: the shared ◐ rotation
//  (TRUTH tier — state-carrying, never pauses, 160ms lattice via
//  WorkingGlyph) + the turn's continuous elapsed time + the LIVE token
//  count (the same ref the verb row polls — fed from the connector's
//  turnChars, read-only). The moving count IS the honest "the agent is
//  writing" signal the operator asked for; a count that stops moving for
//  MID_STREAM_STILL_WAITING_MS earns the quiet "still waiting" suffix —
//  derived from the count's own movement on this row's clock, NEVER from
//  the process-local pulse machine (its writers run in the session's child
//  process; in the cockpit it reads generation 0 forever — the old
//  pulse-based still-waiting here was structurally dead). No verb, no
//  shimmer, no second focal sweep — the one-voice law keeps
//  WHAT-is-happening in the transcript prose; this row says work-is-alive,
//  for-how-long, and how-much-has-been-written.
// ============================================================================

// The ×4 lattice subdivision (40ms): while prose streams this row is the ONE
// live working signal, and the tail's render-invisible beats (a code fence's
// trailing-indent deltas paint nothing new) measured 96-128ms visual holds on
// the ux-parity rig against a 70ms p99 gap budget. The faster quarter-moon
// carries the paint cadence through those beats; it still phase-locks to the
// 160ms truth lattice (integral subdivision), and degraded states (reduced
// motion / MERCURY_LIVE_GLYPHS=0) keep their static frame.
const STREAM_GLYPH_TICK_MS = WORK_TICK_MS / 4

export function StreamingHoldRow({
  loadingStartTimeRef,
  totalPausedMsRef,
  pauseStartTimeRef,
  responseLengthRef,
}: {
  loadingStartTimeRef: React.MutableRefObject<number>
  totalPausedMsRef: React.MutableRefObject<number>
  pauseStartTimeRef: React.MutableRefObject<number | null>
  /** The live streamed-char count (the verb row's own ref — REPL feeds it
   *  from the connector's turnChars). Read-only here. */
  responseLengthRef?: React.RefObject<number>
}): React.ReactNode {
  const tokens = useMercuryTokens()
  // Timer cadence: 6× the truth lattice (960ms ⊂ the nested clock family) —
  // the rendered text changes once per tick, so equal frames never commit.
  const [, tick] = useAnimationValue(960, t => Math.floor(t / 960))
  void tick
  const now = Date.now()
  // INC-4549 hard floor (same law as SpinnerAnimationRow): never read an
  // unstamped turn clock — an unset ref gets this row's first frame.
  if (loadingStartTimeRef.current === 0) {
    loadingStartTimeRef.current = now
  }
  const elapsedMs =
    pauseStartTimeRef.current !== null
      ? pauseStartTimeRef.current -
        loadingStartTimeRef.current -
        totalPausedMsRef.current
      : now - loadingStartTimeRef.current - totalPausedMsRef.current
  // The live token figure: chars/4, the estimation idiom the verb row uses.
  const liveChars = responseLengthRef?.current ?? 0
  const liveTokens = Math.floor(liveChars / 4)
  // Still-waiting from the count's OWN movement (sampled on this row's
  // 960ms tick — the 10s threshold dwarfs the cadence): while prose streams
  // this row is the only working signal, and a count that stands still for
  // MID_STREAM_STILL_WAITING_MS is a real mid-stream gap.
  const movementRef = useRef({ lastChars: -1, lastMovedAt: now })
  if (movementRef.current.lastChars !== liveChars) {
    movementRef.current = { lastChars: liveChars, lastMovedAt: now }
  }
  const stillWaiting = now - movementRef.current.lastMovedAt >= MID_STREAM_STILL_WAITING_MS
  // Left-anchored like the whole status-row family (the anchor law in
  // SpinnerAnimationRow): this row's elapsed text resizes every tick, and the
  // hold row must sit at the same fixed column the verb row vacated — the row
  // swap never jumps anchors.
  return (
    <Box height={1} width="100%">
      <Text>
        <WorkingGlyph color={tokens.textSecondary} tickMs={STREAM_GLYPH_TICK_MS} />
        <Text color={tokens.textMuted}> {formatDuration(Math.max(0, elapsedMs))}</Text>
        {liveTokens > 0 ? (
          <Text color={tokens.textMuted}> · ↓ {liveTokens.toLocaleString('en-US')} tokens</Text>
        ) : null}
        {stillWaiting ? <Text color={tokens.textMuted}> · still waiting</Text> : null}
      </Text>
    </Box>
  )
}
