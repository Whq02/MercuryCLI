import * as React from 'react'
import { Box, Text } from '../ink.js'
import { AMBER, CLAW, CRIMSON, FAINT, IVORY, OASIS, SAND, TEAL, TERRA } from './mercuryPalette.js'
import { CRAB_GLYPHS as CRAB } from './mercury-ui/assets.js';

export function MercuryTeleport({pct=60}:{pct?:number}){
  // Clamp the fill to [0,14] so an out-of-range pct (a caller passing >100 or <0)
  // can't drive 'repeat(14-f)' negative → RangeError crash (matches the safe bar()
  // pattern in MercuryModelPicker).
  const f=Math.max(0,Math.min(14,Math.round(pct/100*14)))
  return (<Box flexDirection="column" borderStyle="round" borderColor={OASIS} paddingX={1}>
    <Text><Text color={OASIS}>{'⌗'}</Text> <Text bold color={IVORY}>teleport</Text> <Text color={FAINT}>syncing worktree{'…'}</Text></Text>
    <Text><Text color={OASIS}>{'█'.repeat(f)}</Text><Text color={FAINT}>{'░'.repeat(14-f)}</Text> <Text color={SAND}>{pct}{'%'}</Text></Text>
  </Box>)}
