import * as React from 'react'
import { Text } from '../../ink.js'
import { FAINT } from '../mercuryPalette.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'

// ============================================================================
//  The IN-FLIGHT streaming nameplate. The finalized prose leads with
//  `HH:MM:SS [Mercury]` (TranscriptNameplate); the live turn has no stored
//  timestamp yet, so the clock's WIDTH is reserved blank and its digits fade
//  in on finalize (honest: never Date.now() at render; geometry never changes
//  at settle).
// ============================================================================

/**
 * The width of the finalized clock prefix (`HH:MM:SS ` — pad2 24h, always 9
 * cells). The IN-FLIGHT nameplate RESERVES this width as a blank slot: the
 * streaming turn has no stored timestamp yet and fabricating one is
 * forbidden (never Date.now() at render), but WITHOUT the slot the clock's
 * arrival at finalize widened line 1 by 9 cells and REWRAPPED the whole
 * settled paragraph. With it, settle fills the slot in place — a
 * row-coordinate no-op — and streaming prose sits on the same column grid as
 * every finalized line above it.
 */
const CLOCK_SLOT = '         ' // 9 spaces = stringWidth('HH:MM:SS ')

/**
 * The `[Mercury]` nameplate for the IN-FLIGHT streaming block. Must NOT read
 * MessageMetaContext (it is null at the streaming site, where
 * TranscriptNameplate self-omits) — it reads only the session accent.
 */
export function MercuryStreamingNameplate(): React.ReactNode {
  const critter = useSessionAccent()
  return (
    <Text>
      {CLOCK_SLOT}
      <Text color={FAINT}>[</Text>
      <Text color={critter.accent}>Mercury</Text>
      <Text color={FAINT}>] </Text>
    </Text>
  )
}
