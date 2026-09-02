import * as React from 'react'
import { Text } from '../../ink.js'
import { useMercuryTokens } from './useMercuryTokens.js'
import { useAppStateMaybeOutsideOfProvider } from '../../state/AppState.js'
import { harnessEffortFact, resolveActiveHarnessProfile } from '../../services/mission/harnessApplication.js'
import type { HarnessProfileResolution } from '../../services/mission/harnessProfiles.js'

// ============================================================================
//  HarnessChip — the compact statusline harness-profile identity (the
//  pending-chip precedent). Armed-only: while
//  MERCURY_HARNESS_PROFILE is off the resolution is null and the chip
//  renders NOTHING (byte-absent — the CH-41 certificate covers the frame).
//  UI copy law: the word is "harness" (the drill-in says "harness
//  profile"), never a bare "profile".
// ============================================================================

/** Pure label derivation (prover-pinned): null ⇒ no chip bytes at all. */
export function harnessChipLabel(resolution: HarnessProfileResolution | null): string | null {
  if (resolution === null) return null
  return ` · harness ${resolution.profileId}`
}

export function HarnessChip({ model, show }: { model: string; show: boolean }): React.ReactNode {
  const tok = useMercuryTokens()
  // The effort fact rides the session's effort value through the one owner
  // (the profiles' effort axis judges the tier the request carries).
  const effortValue = useAppStateMaybeOutsideOfProvider(s => s.effortValue)
  // O(1): the facts-keyed resolution cache makes this a lookup on every
  // render after the first (the CH-28 steady state); off ⇒ null, zero work.
  const label = harnessChipLabel(
    show ? resolveActiveHarnessProfile({ model, effortLevel: harnessEffortFact(model, effortValue) }) : null,
  )
  if (label === null) return null
  return <Text color={tok.textMuted}>{label}</Text>
}
