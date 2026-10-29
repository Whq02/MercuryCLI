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

export function StreamingHoldRow({
  loadingStartTimeRef,
  totalPausedMsRef,
  pauseStartTimeRef,
  responseLengthRef,
  outputTokensRef,
  liveTurnFactsRef,
}: {
  loadingStartTimeRef: React.MutableRefObject<number>
  totalPausedMsRef: React.MutableRefObject<number>
  pauseStartTimeRef: React.MutableRefObject<number | null>
  responseLengthRef?: React.RefObject<number>
  outputTokensRef?: React.RefObject<number | null>
  liveTurnFactsRef?: React.RefObject<LiveTurnFactsV1>
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const [, tick] = useAnimationValue(960, t => Math.floor(t / 960))
  void tick
  const now = Date.now()
  if (loadingStartTimeRef.current === 0) {
    loadingStartTimeRef.current = now
  }
  const elapsedMs =
    pauseStartTimeRef.current !== null
      ? pauseStartTimeRef.current -
        loadingStartTimeRef.current -
        totalPausedMsRef.current
      : now - loadingStartTimeRef.current - totalPausedMsRef.current
  const liveChars = responseLengthRef?.current ?? Number.NaN
  const liveWords = liveCounterWords(
    { ...(liveTurnFactsRef?.current ?? turnFactsOfRefs(liveChars, outputTokensRef?.current ?? null)), phase: 'writing', sentAtMs: now - Math.max(0, elapsedMs) },
    now,
  )
  const otps = useOutputRate(liveTurnFactsRef?.current.replyChars ?? liveChars, pauseStartTimeRef.current === null && liveWords.promise === null, now)
  const stripLines = turnStripLines(loadingStartTimeRef.current, 1)
  return (
    <Box height={stripLines} width="100%">
      <Text>
        <WorkingGlyph color={tokens.textSecondary} tickMs={STREAM_GLYPH_TICK_MS} />
        <Text color={tokens.textMuted}> {formatDuration(Math.max(0, elapsedMs))}</Text>
        {liveWords.count !== null ? (
          <Text color={tokens.textMuted}> · {liveWords.count}</Text>
        ) : null}
        {otps >= 1 ? <Text color={tokens.textMuted}> · ~{otps} tok/s</Text> : null}
        {liveWords.promise !== null ? <Text color={tokens.textMuted}> · {liveWords.promise}</Text> : null}
      </Text>
    </Box>
  )
}
