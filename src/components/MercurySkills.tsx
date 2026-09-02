import * as React from 'react'
import { Box, Text } from '../ink.js'
import { AMBER, CLAW, CRIMSON, FAINT, IVORY, OASIS, SAND, TEAL, TERRA } from './mercuryPalette.js'
import { padTo } from './mercury-ui/glyphs.js'
import { CRAB_GLYPHS as CRAB } from './mercury-ui/assets.js';

const SK=[['compoundv','on',TEAL],['loop','off',FAINT],['anti-lazy','on',TEAL]]
export function MercurySkills(){return (
  <Box flexDirection="column" borderStyle="round" borderColor={TERRA} paddingX={1}>
    <Text bold color={TERRA}>{CRAB} skills</Text>
    {SK.map(([n,s,c]:any)=>(<Text key={n}><Text color={c}>{s==='on'?'●':'○'} </Text><Text color={IVORY}>{padTo(n,14)}</Text><Text color={FAINT}>{s}</Text></Text>))}
    <Text color={FAINT}>{'↑↓ · ↵ toggle · esc'}</Text>
  </Box>)}
