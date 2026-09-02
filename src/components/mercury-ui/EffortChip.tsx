// mercury-ui/EffortChip — the standing LIVE effort chip beside the model name
// (task #11, operator: "the ACTUAL resolved effort … combined with
// the mode (supercode) — NOT a static parroted label").
//
// Truth source: getDisplayedEffortLevel — the SAME honest resolve the Logo
// suffix and the effort-changed toast use (turn floors + the non-max-model
// clamp included), so the chip can never disagree with what the API receives.
// Subscribes to AppState (effortValue + the supercode mode flag) via the
// provider-tolerant hook so mid-session /effort changes repaint the chip live
// wherever it is mounted (DeckPane strip, MercuryFrame statusbar).
//
// Renders as a <Text> run designed to sit INSIDE a parent <Text>: the leading
// ' · ' separator lives inside the chip, so a null chip (a model with no
// effort axis) leaves no orphan separator behind. Reads:
//   " · ◉ max"                  (a plain level)
//   " · supercode · ◉ max"      (the standing mode + its pinned level)
// Colors: separators/labels FAINT, the level word SECOND, the supercode word
// in tokens.info (a standing mode chip is INFORMATION —;
// identity accent is reserved for identity/focus paint).

import * as React from 'react'
import { Text } from '../../ink.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useAppStateMaybeOutsideOfProvider } from '../../state/AppState.js'
import {
  getDisplayedEffortLabel,
  getDisplayedEffortLevel,
  modelSupportsEffort,
} from '../../utils/effort.js'
import { FAINT, SECOND } from '../mercuryPalette.js'
import { effortLevelToSymbol } from '../EffortIndicator.js'
import { useMercuryTokens } from './useMercuryTokens.js'

export function EffortChip({ model }: { model: string }): React.ReactNode {
  const effortValue = useAppStateMaybeOutsideOfProvider(s => s.effortValue)
  const supercode = useAppStateMaybeOutsideOfProvider(s => s.supercode)
  const tokens = useMercuryTokens()
  // <100 cols the mode WORD is shed (the symbol+level stay) — the statusbar's
  // ordered pressure budget was tuned before this chip existed, and the full
  // ` · supercode · ◉ max` run starved the right-side vitals at 80 cols
  // Mirrors the frame's behavior-chip shed threshold.
  const { columns } = useTerminalSize()
  if (!model || !modelSupportsEffort(model)) return null
  // the WORD is the truthful label (out-of-ladder provider tiers,
  // the honest 'default' when the wire omits the key); the symbol keeps the
  // ladder projection.
  const level = getDisplayedEffortLevel(model, effortValue)
  const label = getDisplayedEffortLabel(model, effortValue)
  return (
    <Text>
      <Text color={FAINT}> · </Text>
      {supercode && columns >= 100 ? (
        <>
          <Text color={tokens.info}>supercode</Text>
          <Text color={FAINT}> · </Text>
        </>
      ) : null}
      <Text color={FAINT}>{effortLevelToSymbol(level)} </Text>
      <Text color={SECOND}>{label}</Text>
    </Text>
  )
}
