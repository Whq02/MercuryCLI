import * as React from 'react'
import { Box, Text } from '../ink.js'
import { AMBER, CLAW, CRIMSON, FAINT, IVORY, OASIS, SAND, TEAL, TERRA } from './mercuryPalette.js'
import { CRAB_GLYPHS as CRAB } from './mercury-ui/assets.js';

const NT=[['●','update available 1.0.0-beta.1',TEAL],['⦿','swarm backend gated',AMBER],['○','3 extensions off',FAINT]]
export function MercuryNotices(){return (
  <Box flexDirection="column">
    {NT.map(([g,t,c]:any,i:number)=>(<Text key={i}><Text color={c}>{g} </Text><Text color={SAND}>{t}</Text></Text>))}
  </Box>)}
