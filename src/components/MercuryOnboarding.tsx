import * as React from 'react'
import { Box, Text } from '../ink.js'
import { AMBER, CLAW, CRIMSON, FAINT, IVORY, OASIS, SAND, TEAL, TERRA } from './mercuryPalette.js'
import { CRAB_GLYPHS as CRAB } from './mercury-ui/assets.js';

export function MercuryOnboarding({step=1,total=4}:{step?:number;total?:number}){return (
  <Box flexDirection="column" borderStyle="round" borderColor={TERRA} paddingX={2} paddingY={1}>
    <Text bold color={TERRA}>{CRAB} setup <Text color={FAINT}>{step}/{total}</Text></Text>
    <Text color={IVORY}>Pick your session critter</Text>
    <Text color={SAND}>it themes the whole harness {'—'} status colors stay fixed</Text>
    <Box height={1}/>
    <Text color={FAINT}>{'❯ enter to continue · esc skip'}</Text>
  </Box>)}
