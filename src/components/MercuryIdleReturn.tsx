import * as React from 'react'
import { Box, Text } from '../ink.js'
import { AMBER, CLAW, CRIMSON, FAINT, IVORY, OASIS, SAND, TEAL, TERRA } from './mercuryPalette.js'
import { CRAB_GLYPHS as CRAB } from './mercury-ui/assets.js';

export function MercuryIdleReturn({idle='12m'}:{idle?:string}){return (
  <Box><Text color={TEAL}>{'●'}</Text> <Text color={SAND}>welcome back {'·'} {idle} idle {'·'} session resumed</Text></Box>)}
