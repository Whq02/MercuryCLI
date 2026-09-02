// ============================================================================
//  MercuryMissionIndicator — the persistent "/mission active" chip.
//
//  Whenever a standing mission is set this renders `◎ /mission active (18m)`
//  near the prompt, with the elapsed clock live; with no mission it renders
//  nothing at all. The chip is INFORMATION, not identity, so the glyph is
//  tinted tokens.info, the label is IVORY, and the elapsed meta is FAINT.
//
//  Clocking is adaptive: second-granular ticks while the reading is under a
//  minute (seconds still matter there), minute-granular after — and each
//  timer fires ON its boundary, so the digit changes the moment it should.
//  A mission that runs for hours never keeps a per-second timer alive.
// ============================================================================

import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Box, Text } from '../ink.js'
import { getActiveMission } from '../utils/hooks/missionHook.js'
import { formatDuration } from '../utils/format.js'
import { FAINT, IVORY } from './mercuryPalette.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'

/**
 * ◎ BULLSEYE (U+25CE) — the active-mission glyph. Deliberately NOT ◉: the filled
 * fisheye is the tree-wide blocked/danger glyph, and a healthy standing mission
 * must not share valence with it on two always-visible surfaces. ◎ reads as a
 * target. Width-1; the chip isn't column-aligned, so ambiguous-width metrics
 * can't misalign anything.
 */
const MISSION_ACTIVE_GLYPH = '◎'

export function MercuryMissionIndicator(): React.ReactNode {
  // Theme tokens through the live hook, so an /appearance switch repaints
  // this chip along with everything else.
  const tokens = useMercuryTokens()

  // Re-read the mission every render. The ephemeral mission map has no subscribe
  // seam, but a set/clear already re-renders the footer through app state
  // (the same event that mutates the map), and the tick below re-samples.
  const mission = getActiveMission()
  const setAt = mission?.setAt

  // The tick value is never read — bumping it forces a re-render so the
  // elapsed clock re-samples Date.now().
  const [, setTick] = useState(0)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    if (setAt === undefined) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      const elapsed = Date.now() - setAt
      // Under a minute, tick each second; after that, once a minute — and
      // fire ON the boundary, so the reading never lags its own digit.
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
  // No suffix for the first second — "(0s)" is noise, not information.
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
