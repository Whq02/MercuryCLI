
import * as React from 'react'
import { critterDefForKey, squareDockArtFor } from '../../utils/cockpit/critterData.js'
import { FAINT } from '../mercuryPalette.js'
import { useMercuryTokens } from './useMercuryTokens.js'
import { Box, Text } from '../../ink.js'
import { AnimatedCritterArt } from './AnimatedCritterArt.js'
import { GLYPH } from './glyphs.js'
import { useCompanion, useCompanionEnabled, useCompanionSpeechBudget } from './useCompanion.js'
import { cycleSessionCritter } from './sessionAccent.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { fitsBudget, heroBubbleLineBudget, miniBubbleLineBudget, MINI_BUBBLE_MIN_COLS } from './companionBudget.js'

export function MiniCritter({ cols, bare = false }: { cols: number; bare?: boolean }): React.ReactNode {
  const c = useCompanion()
  const { accentSoft } = useMercuryTokens()
  const def = critterDefForKey(c.critter.key)
  const miniDef = React.useMemo(
    () => ({
      ...def,
      hue: c.critter.accent,
      hueDeep: c.critter.accentDeep,
      square: squareDockArtFor(c.critter.key),
    }),
    [def, c.critter.accent, c.critter.accentDeep, c.critter.key],
  )
  if (bare) {
    return <BareMiniArt miniDef={miniDef} />
  }
  return <SpeakingMiniRow c={c} miniDef={miniDef} cols={cols} accentSoft={accentSoft} />
}

function BareMiniArt({ miniDef }: { miniDef: React.ComponentProps<typeof AnimatedCritterArt>['def'] }): React.ReactNode {
  return (
    <Box onClick={cycleSessionCritter}>
      <AnimatedCritterArt def={miniDef} square />
    </Box>
  )
}

function SpeakingMiniRow({
  c,
  miniDef,
  cols,
  accentSoft,
}: {
  c: ReturnType<typeof useCompanion>
  miniDef: React.ComponentProps<typeof AnimatedCritterArt>['def']
  cols: number
  accentSoft: string
}): React.ReactNode {
  const bubbleFits = cols >= MINI_BUBBLE_MIN_COLS
  const budget = miniBubbleLineBudget(cols)
  useCompanionSpeechBudget(budget)
  const line = c.quip && fitsBudget(c.quip.text, budget) ? c.quip : null
  return (
    <Box flexDirection="column" alignItems="center">
      <Box flexDirection="row" alignItems="center">
        <Text>
          <Text color={accentSoft}>{GLYPH.sparkFaint}</Text>
          <Text color={FAINT}>{' ── '}</Text>
        </Text>
        <Box onClick={cycleSessionCritter}>
          <AnimatedCritterArt def={miniDef} square />
        </Box>
        <Text>
          <Text color={FAINT}>{' ── '}</Text>
          <Text color={accentSoft}>{GLYPH.sparkFaint}</Text>
        </Text>
        {line && bubbleFits ? (
          <>
            <Text color={line.fading ? FAINT : c.tone}>─</Text>
            <Box
              borderStyle="round"
              borderColor={line.fading ? FAINT : c.tone}
              paddingX={1}
              flexShrink={0}
            >
              <Text italic dimColor={line.fading}>
                {line.text}
              </Text>
            </Box>
          </>
        ) : null}
      </Box>
      {line && !bubbleFits ? (
        <Text italic color={line.fading ? FAINT : c.tone}>
          {`"${line.text}"`}
        </Text>
      ) : null}
    </Box>
  )
}

export function BerthCompanionLine(): React.ReactNode {
  const on = useCompanionEnabled()
  if (!on) return null
  return <HeroCompanionBubble />
}

export function HeroCompanionBubble(): React.ReactNode {
  const c = useCompanion()
  const budget = heroBubbleLineBudget(useTerminalSize().columns)
  useCompanionSpeechBudget(budget)
  const line = c.quip && fitsBudget(c.quip.text, budget) ? c.quip : null
  if (!line) {
    return null
  }
  return (
    <Box flexDirection="row" alignItems="center" flexShrink={0}>
      <Text color={line.fading ? FAINT : c.tone}>─</Text>
      <Box
        borderStyle="round"
        borderColor={line.fading ? FAINT : c.tone}
        paddingX={1}
        flexShrink={0}
      >
        <Text italic dimColor={line.fading}>
          {line.text}
        </Text>
      </Box>
    </Box>
  )
}
