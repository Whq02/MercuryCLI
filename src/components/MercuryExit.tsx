import * as React from 'react'
import { Box, Text } from '../ink.js'
import { AMBER, CLAW, CRIMSON, FAINT, IVORY, OASIS, SAND, TEAL, TERRA } from './mercuryPalette.js'
import { CRAB_GLYPHS as CRAB } from './mercury-ui/assets.js';

export function MercuryExit(){return (
  <Box flexDirection="column" borderStyle="round" borderColor={TERRA} paddingX={1}>
    <Text><Text color={TERRA}>{CRAB}</Text> <Text color={IVORY}>Leave Mercury?</Text></Text>
    <Text color={FAINT}>session saved · resume with /sessions</Text>
    <Text><Text color={CRIMSON}>[y]</Text> <Text color={SAND}>quit</Text>  <Text color={TEAL}>[n]</Text> <Text color={SAND}>stay</Text></Text>
  </Box>)}
