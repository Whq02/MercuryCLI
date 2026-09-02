import * as React from 'react'
import { Box, Text } from '../ink.js'
import { AMBER, CLAW, CRIMSON, FAINT, IVORY, OASIS, SAND, TEAL, TERRA } from './mercuryPalette.js'
import { CRAB_GLYPHS as CRAB } from './mercury-ui/assets.js';

export function MercuryLogin(){return (
  <Box flexDirection="column" borderStyle="round" borderColor={TERRA} paddingX={1}>
    <Text bold color={TERRA}>{CRAB} sign in</Text>
    <Text color={SAND}>opening browser to authenticate{'…'}</Text>
    <Text color={FAINT}>or paste the code:</Text>
    <Text color={IVORY}>MERCURY-4F2A-9C1B</Text>
    <Text color={FAINT}>esc cancel</Text>
  </Box>)}
