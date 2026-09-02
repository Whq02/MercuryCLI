import * as React from 'react'
import { useSyncExternalStore } from 'react'
import { Box, Text } from '../ink.js'
import { getActiveMission } from '../utils/hooks/missionHook.js'
import { requestCommandDispatch } from '../utils/cockpit/helmFocus.js'
import {
  liveClockEnabled,
  liveClockSnapshot,
  subscribeLiveClock,
  subscribeLiveClockDisabled,
} from '../utils/cockpit/liveClock.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { GLYPH, truncateToWidth } from './mercury-ui/glyphs.js'
import { InteractiveRow } from './mercury-ui/InteractiveRow.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'

// ============================================================================
//  HelmCenterHeader — the cockpit center panel's header band (
//  panel pass, mockup-ratified): `✶ SESSION` on the left, the active /mission as
//  a `MISSION:` segment when one is set (honest-absent otherwise), and a live
//  HH:MM:SS clock on the right. Mounted as the first interior row of the
//  bordered center panel, cockpit tier only. The band deliberately carries NO
//  wordmark — the single-brand law reserves
//  the product name for the transcript's banner-header; this row is
//  session-state furniture.
//
//  The clock is REAL time through the ONE live-clock owner (utils/cockpit/
//  liveClock — the registered MERCURY_LIVE_CLOCK gate): enabled, the shared
//  1 Hz store re-renders this leaf row only; disabled (=0 — every capture
//  pins it), the baked snapshot stands and the idle screen stays
//  byte-still. The self-owned useNowTick this header carried bypassed the
//  registered off-switch — the one clock no capture could still.
// ============================================================================

export function HelmCenterHeader({ width }: { width: number }): React.ReactNode {
  const t = useMercuryTokens()
  const { accent } = useSessionAccent()
  const clock = useSyncExternalStore(
    liveClockEnabled() ? subscribeLiveClock : subscribeLiveClockDisabled,
    liveClockSnapshot,
    liveClockSnapshot,
  )
  const mission = getActiveMission()
  // The mission text lives in the gap between '✶ SESSION' and the right-pinned
  // clock. Budget out ALL the fixed furniture it must clear: paddingX (2) +
  // '✶ SESSION' (9) + the ' MISSION: ' lead-in (12) + the clock + 1 air.
  // (The old formula subtracted only ~14 — it forgot the MISSION: label and the
  // padding, so a long mission ran ~10 cells past the border into the clock.)
  const missionBudget = Math.max(0, width - 24 - clock.length)
  return (
    // The left segment HARD-shrinks under a truncate-end and the clock never
    // shrinks, so the band can NEVER spill past the border into the clock even
    // if the budget above drifts (glyph widths, a renamed label). Two belts:
    // the budget keeps the truncation point sane, the flex keeps it honest.
    // minWidth={0} lets the left box shrink below its longest word so
    // truncate-end can actually clip (Yoga's default min-content would block it).
    <Box width={width} paddingX={1} justifyContent="space-between" flexShrink={0}>
      <Box flexShrink={1} minWidth={0}>
        {/* Two DISTINCT direct-activate targets:
            '✶ SESSION' opens the /sessions switcher, the MISSION segment
            opens the /mission status panel — each claims hover separately, so a
            click always has ONE owner. The mission box carries the squeeze
            (SESSION stays fixed); the clock never shrinks. */}
        <InteractiveRow
          id="helm:center:session"
          directActivate
          onActivate={() => requestCommandDispatch('/sessions')}
          height={1}
          flexShrink={0}
        >
          {/* Hover-hierarchy: chrome hover is INK (function child — no
              surface2 slab); the spark keeps the accent in both states — the
              band's ONE identity cue per AURORA. */}
          {hover => (
            <Text>
              <Text color={accent}>{GLYPH.spark} </Text>
              <Text color={hover ? t.info : t.textMuted}>SESSION</Text>
            </Text>
          )}
        </InteractiveRow>
        {mission && missionBudget > 12 ? (
          <InteractiveRow
            id="helm:center:mission"
            directActivate
            onActivate={() => requestCommandDispatch('/mission')}
            height={1}
            flexShrink={1}
          >
            {hover => (
              <Text wrap="truncate-end">
                <Text color={t.textMuted}>{'   '}</Text>
                {/* An informational heading: the info channel — the ✶
                    SESSION spark above keeps the center band's ONE identity cue.
                    Hover brightens the label to infoShimmer (ink, no slab). */}
                <Text color={hover ? 'infoShimmer' : t.info} bold>
                  MISSION:
                </Text>
                <Text color={t.textSecondary}> {truncateToWidth(mission.condition, missionBudget)}</Text>
              </Text>
            )}
          </InteractiveRow>
        ) : null}
      </Box>
      <Box flexShrink={0} marginLeft={1}>
        <Text color={t.textMuted}>{clock}</Text>
      </Box>
    </Box>
  )
}
