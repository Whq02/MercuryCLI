import React, { useRef } from 'react'
import { Box, Text } from '../../ink.js'
import { useAnimationValue } from '../../ink/hooks/use-animation-value.js'
import type { Theme } from '../../utils/theme.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { FOCAL_TICK_MS, WORK_TICK_MS } from '../../utils/cockpit/liveGlyphs.js'
import { GLYPH } from '../../utils/glyphs.js'
import { GlimmerMessage } from './GlimmerMessage.js'
import { hookWaitLineOf } from '../../utils/hooks/wait.js'
import { getEphemeralProgressFrame, useEphemeralProgressVersion } from '../../state/ephemeralProgressStore.js'
import { SpinnerGlyph } from './SpinnerGlyph.js'
import { useShimmerAnimation } from './useShimmerAnimation.js'
import { useStalledAnimation } from './useStalledAnimation.js'
import { useOutputRate } from './useOutputRate.js'
import { isQuicksilverLine } from '../../constants/spinnerVerbs.js'
import type { SpinnerMode } from '../../types/spinner.js'
import type { LiveTurnFactsV1 } from '../../services/engine-connector/seatLive.js'
import { liveCounterPhaseOf, liveCounterWords, turnFactsOfRefs } from './liveCounterWords.js'
import { turnStripLines } from './stripHeight.js'
import { planSpinnerHud } from './spinnerHud.js'
import { anchoredElapsedMs, anchorSeatClock, type SeatClockAnchor } from './seatClock.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

const SLOW_TICK_MS = WORK_TICK_MS * 2

type SpinnerAnimationRowProps = Unbuilt

const NO_KEYS: readonly string[] = []

export function SpinnerAnimationRow(props: SpinnerAnimationRowProps): React.ReactNode {
  return notBuilt('src/components/Spinner/SpinnerAnimationRow.tsx:50')
}
