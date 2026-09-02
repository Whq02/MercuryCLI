import * as React from 'react'
import { Box, Text } from '../ink.js'
import { AMBER, CLAW, CRIMSON, FAINT, IVORY, OASIS, SAND, TEAL, TERRA } from './mercuryPalette.js'
import { CRAB_GLYPHS as CRAB } from './mercury-ui/assets.js';

export function MercuryBridge({device='MacBook Pro'}:{device?:string}){return (
  <Box flexDirection="column" borderStyle="round" borderColor={TERRA} paddingX={1}>
    <Text bold color={TERRA}>{CRAB} remote bridge</Text>
    <Text><Text color={TEAL}>{'●'}</Text> <Text color={IVORY}>{device}</Text> <Text color={FAINT}>trusted</Text></Text>
    <Text color={SAND}>Remote Control active</Text>
    <Text color={FAINT}>{'↑↓ device · ↵ connect · esc'}</Text>
  </Box>)}
