// ============================================================================
//  MercurySupercodeDivider — the warm-ink supercode-activation rule.
//
//  The one-shot transcript marker shown the moment supercode MODE turns on (via
//  /effort supercode or the slider's supercode stop). Format mirrors the host's
//  reference divider — a centered box-drawing rule reading `─── supercode ───` —
//  but rendered in OUR design: the rule is tinted by the warm-ink SESSION ACCENT
//  (terra family; MERCURY_CRITTER re-tints it, so a non-crab session shows that
//  critter's hue by design — the identity re-tint, not a hardcoded violet leak).
//
//  This is NOT a persistent header. It's emitted once on activation (as a short-
//  lived notification fired from effort.tsx's applier) so it reads as "supercode
//  engaged" at the seam, then clears. Built on the shared `Divider` primitive
//  (its `color` prop carries the accent — the FAINT default is untouched). No new
//  hex (accent comes from sessionAccent), no emoji, geometric box-drawing only.
// ============================================================================

import * as React from 'react'
import { Divider } from './mercury-ui/components.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'

// The accent-tinted supercode rule. SUBSCRIBED (useSessionAccent) so a live
// /critter · /accent pick re-tints mounted dividers in the same commit — a
// memoized transcript row never re-renders for a plain read, which left old
// rules wearing the previous accent. `width` defaults to the compact rule.
export function MercurySupercodeDivider({
  width = 30,
}: {
  width?: number
}): React.ReactNode {
  return <Divider label="supercode" width={width} color={useSessionAccent().accent} />
}

export default MercurySupercodeDivider
