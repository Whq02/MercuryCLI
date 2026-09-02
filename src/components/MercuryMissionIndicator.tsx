
import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Box, Text } from '../ink.js'
import { getActiveMission } from '../utils/hooks/missionHook.js'
import { formatDuration } from '../utils/format.js'
import { FAINT, IVORY } from './mercuryPalette.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'

const MISSION_ACTIVE_GLYPH = '◎'

export function MercuryMissionIndicator(): React.ReactNode {
  const tokens = useMercuryTokens()

  const mission = getActiveMission()
  const setAt = mission?.setAt

  const [, setTick] = useState(0)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    if (setAt === undefined) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      const elapsed = Date.now() - setAt
      const period = elapsed < 60_000 ? 1_000 : 60_000
      const delay = period - (elapsed % period)
      timer = setTimeout(() => {
        if (!aliveRef.current) return
        setTick(n => n + 1)
        schedule()
      }, delay)
    }
    schedule()
    return () => {
      aliveRef.current = false
      if (timer) clearTimeout(timer)
    }
  }, [setAt])

  if (setAt === undefined) return null

  const elapsedMs = Date.now() - setAt
  const elapsedSuffix =
    elapsedMs < 1_000
      ? ''
      : ` (${formatDuration(elapsedMs, { mostSignificantOnly: true })})`

  return (
    <Box flexShrink={0}>
      <Text color={tokens.info}>
        {MISSION_ACTIVE_GLYPH}
        <Text color={IVORY}> /mission active</Text>
        {elapsedSuffix ? <Text color={FAINT}>{elapsedSuffix}</Text> : null}
      </Text>
    </Box>
  )
}

export default MercuryMissionIndicator
