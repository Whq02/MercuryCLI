import * as React from 'react'
import { Box, Text } from '../ink.js'
import { AMBER, CLAW, CRIMSON, FAINT, IVORY, OASIS, SAND, TEAL, TERRA } from './mercuryPalette.js'
import { padTo } from './mercury-ui/glyphs.js'
import { CRAB_GLYPHS as CRAB } from './mercury-ui/assets.js';

const SB=[['network','deny',CRIMSON],['filesystem','workspace',TEAL],['exec','prompt',AMBER]]
export function MercurySandbox(){return (
  <Box flexDirection="column" borderStyle="round" borderColor={TERRA} paddingX={1}>
    <Text bold color={TERRA}>{CRAB} sandbox</Text>
    {SB.map(([k,v,c]:any)=>(<Text key={k}><Text color={FAINT}>{padTo(k,12)}</Text><Text color={c}>{v}</Text></Text>))}
    <Text color={FAINT}>{'↑↓ · ↵ cycle · esc'}</Text>
  </Box>)}
