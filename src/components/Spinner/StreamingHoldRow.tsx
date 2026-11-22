import * as React from 'react'
import { Box, Text, useAnimationValue } from '../../ink.js'
import { formatDuration } from '../../utils/format.js'
import { WorkingGlyph } from '../mercury-ui/LiveGlyphs.js'
import { WORK_TICK_MS } from '../../utils/cockpit/liveGlyphs.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { useOutputRate } from './useOutputRate.js'
import { liveCounterWords, turnFactsOfRefs } from './liveCounterWords.js'
import { turnStripLines } from './stripHeight.js'
import type { LiveTurnFactsV1 } from '../../services/engine-connector/seatLive.js'
import { notBuilt } from '../../pi/holes.js'


const STREAM_GLYPH_TICK_MS = WORK_TICK_MS / 4

export function StreamingHoldRow(arg0: {
  loadingStartTimeRef: React.MutableRefObject<number>
  totalPausedMsRef: React.MutableRefObject<number>
  pauseStartTimeRef: React.MutableRefObject<number | null>
  responseLengthRef?: React.RefObject<number>
  outputTokensRef?: React.RefObject<number | null>
  liveTurnFactsRef?: React.RefObject<LiveTurnFactsV1>
}): React.ReactNode {
  return notBuilt('src/components/Spinner/StreamingHoldRow.tsx:15')
}
