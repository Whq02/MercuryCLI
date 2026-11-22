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

const STREAM_GLYPH_TICK_MS = WORK_TICK_MS / 4

export function StreamingHoldRow({ loadingStartTimeRef, totalPausedMsRef, pauseStartTimeRef, responseLengthRef, outputTokensRef, liveTurnFactsRef }: {
  loadingStartTimeRef: React.MutableRefObject<number>
  totalPausedMsRef: React.MutableRefObject<number>
  pauseStartTimeRef: React.MutableRefObject<number | null>
  responseLengthRef?: React.RefObject<number>
  outputTokensRef?: React.RefObject<number | null>
  liveTurnFactsRef?: React.RefObject<LiveTurnFactsV1>
}): React.ReactNode {
  const now = Date.now()
  if (loadingStartTimeRef.current === 0) loadingStartTimeRef.current = now
  const start = loadingStartTimeRef.current
  const elapsed = Math.max(0, (pauseStartTimeRef.current ?? now) - start - totalPausedMsRef.current)
  useAnimationValue(960, time => Math.floor(time / 960))
  const length = responseLengthRef?.current ?? NaN
  const facts = liveTurnFactsRef?.current ?? turnFactsOfRefs(length, outputTokensRef?.current ?? null)
  const { count, promise } = liveCounterWords({ ...facts, phase: 'writing', sentAtMs: now - elapsed }, now)
  const rate = useOutputRate(liveTurnFactsRef?.current.replyChars ?? length, pauseStartTimeRef.current === null && promise === null, now)
  const { textMuted, textSecondary } = useMercuryTokens()
  return (
    <Box width="100%" height={turnStripLines(start, 1)}>
      <Text>
        <WorkingGlyph color={textSecondary} tickMs={STREAM_GLYPH_TICK_MS} />
        <Text color={textMuted}> {formatDuration(elapsed)}</Text>
        {count !== null && <Text color={textMuted}> · {count}</Text>}
        {rate >= 1 && <Text color={textMuted}> · ~{rate} tok/s</Text>}
        {promise !== null && <Text color={textMuted}> · {promise}</Text>}
      </Text>
    </Box>
  )
}
