// mercury-ui/TrimChip — the standing instruction-estate trim notice, riding
// at the statusbar's far right among the hints (a hint never outranks a
// live vital under truncate-end pressure — SSR-01) with the EffortChip
// grammar: the leading ' · ' separator lives INSIDE the chip, so an unarmed
// chip leaves no orphan separator; unarmed ⇒ byte-absent.
//
// Truth source: the effective-size measure over the SAME composed discovery
// the prompt reads (services/instructions/effectiveSize.ts) — the chip can
// never disagree with what the session actually loaded. Armed past ~400
// EFFECTIVE lines (the entry file plus everything the import law pulls in);
// gone when the estate is tightened. A NOTICE only — nothing here (or
// anywhere) auto-edits the instruction file. tokens.warning: a standing
// look-cue, not a failure.

import * as React from 'react'
import { useSyncExternalStore } from 'react'
import { Text } from '../../ink.js'
import {
  getTrimChipSnapshot,
  subscribeTrimChip,
} from '../../services/instructions/effectiveSize.js'
import { FAINT } from '../mercuryPalette.js'
import { useMercuryTokens } from './useMercuryTokens.js'

/** The chip's copy — operator-ruled, verbatim. */
export const TRIM_CHIP_TEXT =
  'trim mercury.md to optimise performance and reduce context bloat'

export function TrimChip(): React.ReactNode {
  const snap = useSyncExternalStore(
    subscribeTrimChip,
    getTrimChipSnapshot,
    getTrimChipSnapshot,
  )
  const tokens = useMercuryTokens()
  if (!snap.armed) return null
  return (
    <Text>
      <Text color={FAINT}> · </Text>
      <Text color={tokens.warning}>{TRIM_CHIP_TEXT}</Text>
    </Text>
  )
}
