import * as React from 'react'
import { Box, Text } from '../ink.js'
import { AMBER, CRIMSON, FAINT, IVORY, OASIS, SAND, TEAL, TERRA } from './mercuryPalette.js'
import { CRAB_GLYPHS as CRAB } from './mercury-ui/assets.js';

export function MercuryEmergencyTip({tip='press esc twice to interrupt a run'}:{tip?:string}){return (
  <Box borderStyle="round" borderColor={AMBER} paddingX={1}><Text><Text color={AMBER}>{'▲'}</Text> <Text color={SAND}>{tip}</Text></Text></Box>)}
