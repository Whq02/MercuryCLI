import * as React from 'react'
import { useRef } from 'react'
import { Box, Text, useAnimationValue } from '../../ink.js'
import { formatDuration } from '../../utils/format.js'
import { WorkingGlyph } from '../mercury-ui/LiveGlyphs.js'
import { WORK_TICK_MS } from '../../utils/cockpit/liveGlyphs.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { MID_STREAM_STILL_WAITING_MS } from './useStalledAnimation.js'


const STREAM_GLYPH_TICK_MS = WORK_TICK_MS / 4

export function StreamingHoldRow({
  loadingStartTimeRef,
  totalPausedMsRef,
  pauseStartTimeRef,
  responseLengthRef,
}: {
  loadingStartTimeRef: React.MutableRefObject<number>
  totalPausedMsRef: React.MutableRefObject<number>
  pauseStartTimeRef: React.MutableRefObject<number | null>
  responseLengthRef?: React.RefObject<number>
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
  const liveChars = responseLengthRef?.current ?? 0
  const liveTokens = Math.floor(liveChars / 4)
  const movementRef = useRef({ lastChars: -1, lastMovedAt: now })
  if (movementRef.current.lastChars !== liveChars) {
    movementRef.current = { lastChars: liveChars, lastMovedAt: now }
  }
  const stillWaiting = now - movementRef.current.lastMovedAt >= MID_STREAM_STILL_WAITING_MS
  return (
    <Box height={1} width="100%">
      <Text>
        <WorkingGlyph color={tokens.textSecondary} tickMs={STREAM_GLYPH_TICK_MS} />
        <Text color={tokens.textMuted}> {formatDuration(Math.max(0, elapsedMs))}</Text>
        {liveTokens > 0 ? (
          <Text color={tokens.textMuted}> · ↓ {liveTokens.toLocaleString('en-US')} tokens</Text>
        ) : null}
        {stillWaiting ? <Text color={tokens.textMuted}> · still waiting</Text> : null}
      </Text>
    </Box>
  )
}
