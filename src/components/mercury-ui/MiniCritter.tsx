
import * as React from 'react'
import { CR_COLS, SQUARE_DOCK_ART_LINES, critterDefForKey, squareDockArtFor } from '../../utils/cockpit/critterData.js'
import { FAINT } from '../mercuryPalette.js'
import { useMercuryTokens } from './useMercuryTokens.js'
import { Box, Text } from '../../ink.js'
import { AnimatedCritterArt } from './AnimatedCritterArt.js'
import { GLYPH } from './glyphs.js'
import { cycleSessionCritter, useSessionAccent } from './sessionAccent.js'

export function MiniCritter({ bare = false }: { bare?: boolean }): React.ReactNode {
  const critter = useSessionAccent()
  const { accentSoft } = useMercuryTokens()
  const def = critterDefForKey(critter.key)
  const miniDef = React.useMemo(
    () => ({
      ...def,
      hue: critter.accent,
      hueDeep: critter.accentDeep,
      square: squareDockArtFor(critter.key),
    }),
    [def, critter.accent, critter.accentDeep, critter.key],
  )
  if (bare) {
    return <BareMiniArt miniDef={miniDef} />
  }
  return (
    <Box flexDirection="row" alignItems="center">
      <Text>
        <Text color={accentSoft}>{GLYPH.sparkFaint}</Text>
        <Text color={FAINT}>{' ── '}</Text>
      </Text>
      <BareMiniArt miniDef={miniDef} />
      <Text>
        <Text color={FAINT}>{' ── '}</Text>
        <Text color={accentSoft}>{GLYPH.sparkFaint}</Text>
      </Text>
    </Box>
  )
}

function BareMiniArt({ miniDef }: { miniDef: React.ComponentProps<typeof AnimatedCritterArt>['def'] }): React.ReactNode {
  return (
    <Box width={CR_COLS} justifyContent="center" alignItems="center" onClick={cycleSessionCritter}>
      <Box width={Math.max(...miniDef.square.map(row => row.length))} height={SQUARE_DOCK_ART_LINES} flexDirection="column" overflow="hidden" flexShrink={0}>
        <AnimatedCritterArt def={miniDef} square />
      </Box>
    </Box>
  )
}
