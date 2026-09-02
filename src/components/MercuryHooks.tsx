import * as React from 'react'
import { Box, Text } from '../ink.js'
import { AMBER, CLAW, CRIMSON, FAINT, IVORY, OASIS, SAND, TEAL, TERRA } from './mercuryPalette.js'
import { padTo } from './mercury-ui/glyphs.js'
import { CRAB_GLYPHS as CRAB } from './mercury-ui/assets.js';

const HK=[['PreToolUse','lease-guard',TEAL],['PostToolUse','format',TEAL],['Stop','none',FAINT]]
export function MercuryHooks(){return (
  <Box flexDirection="column" borderStyle="round" borderColor={TERRA} paddingX={1}>
    <Text bold color={TERRA}>{CRAB} hooks</Text>
    {HK.map(([e,h,c]:any)=>(<Text key={e}><Text color={FAINT}>{padTo(e,13)}</Text><Text color={c}>{h}</Text></Text>))}
    <Text color={FAINT}>{'↑↓ · ↵ edit · esc'}</Text>
  </Box>)}
