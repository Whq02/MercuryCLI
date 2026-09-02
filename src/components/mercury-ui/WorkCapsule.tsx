import * as React from 'react'
import { createContext } from 'react'
import { Box } from '../../ink.js'
import { TerminalSizeContext } from '../../ink/components/TerminalSizeContext.js'
import { useMercuryTokens } from './useMercuryTokens.js'

// ============================================================================
//  WorkCapsule — the cockpit's WORKING instrument chassis (
//  operator design ask: "border the thinking glyph in a sophisticated,
//  matching the design-system way").
//
//  While a turn is live, the berth's working-status strip (spinner verb +
//  byline · tip · turn rollup) rides inside a rounded borderStrong card
//  (DUNE on the dark family) — the same furniture border every cockpit
//  panel wears. NO header row: the spinner's
//  own ✻ verb line IS the state (operator dedup call, live-tested same night
//  — a `◐ WORKING` header stacked over the star row read as two state rows).
//
//  Honesty + cost discipline:
//  · DRESSES only while work is genuinely in flight (`active`) — idle keeps
//    the quiet berth (no border, no padding), and the chassis can never sit
//    around a finished turn.
//  · Provides a WIDTH-TRUE TerminalSizeContext to its interior (the capsule's
//    inner columns), so the spinner byline's right-to-left shed math finally
//    budgets against the space it actually has in the berth (it would otherwise read
//    the whole center column's width — a latent overflow class).
//  · WorkCapsuleContext lets the spinner drop its transcript-mode `│` accent
//    rail inside the capsule (the chassis replaces the rail's containment
//    job; rail + border side-by-side would double the chrome).
//  · STABLE TREE SHAPE: the component renders the
//    SAME Provider > Box > Provider > children structure in every state and
//    toggles only prop VALUES. The old shape returned bare `children` when
//    inactive — every turn boundary reparented (remounted) the status
//    children, resetting their state and re-running their mount effects. A
//    memoized `sizeVal` keeps the inner TerminalSizeContext referentially
//    stable across re-renders so size consumers don't churn.
// ============================================================================

/** True for content rendered inside the WORKING capsule (the spinner reads
 *  this to drop its transcript-mode left rail — one container, not two). */
export const WorkCapsuleContext = createContext<boolean>(false)

export function WorkCapsule({
  active,
  width,
  children,
}: {
  /** A turn is genuinely in flight (spinner showing or leader loading). */
  active: boolean
  /** The strip column's real width (the berth row minus critter + chrome). */
  width: number
  children: React.ReactNode
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const outer = React.useContext(TerminalSizeContext)
  // Too-narrow berths never dress (the border + padding would eat the strip).
  const dressed = active && width >= 24
  const innerW = dressed ? width - 4 : width // round border 2 + paddingX 2
  const sizeVal = React.useMemo(
    () => (dressed && outer ? { columns: innerW, rows: outer.rows } : outer),
    [dressed, outer, innerW],
  )
  return (
    <WorkCapsuleContext.Provider value={dressed}>
      <Box
        flexDirection="column"
        flexShrink={0}
        width={width}
        borderStyle={dressed ? 'round' : undefined}
        borderColor={dressed ? tokens.borderStrong : undefined}
        paddingX={dressed ? 1 : 0}
      >
        {/* Explicit-width interior:
            the layout engine's ratified pin resolves a child's percent width
            against the owner's BORDER-BOX (cellLayout.ts header) — so a
            width="100%" strip child inside the dressed capsule laid out 4
            cols wider than the content area and its wrapped text painted
            through the padding and border. Children resolve against THIS
            unpadded, borderless container, whose width IS the content area —
            no copy, whatever its length, can escape the frame. */}
        <Box flexDirection="column" width={innerW} flexShrink={0}>
          <TerminalSizeContext.Provider value={sizeVal}>
            {children}
          </TerminalSizeContext.Provider>
        </Box>
      </Box>
    </WorkCapsuleContext.Provider>
  )
}
