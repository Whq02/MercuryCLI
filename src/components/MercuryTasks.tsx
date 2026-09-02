import * as React from 'react'
import { Box, Text } from '../ink.js'
import { AMBER, CLAW, CRIMSON, FAINT, IVORY, OASIS, SAND, TEAL, TERRA } from './mercuryPalette.js'
import { padTo } from './mercury-ui/glyphs.js'
import { CRAB_GLYPHS as CRAB } from './mercury-ui/assets.js';

const TK=[['◐','build dist',TEAL,'2m'],['●','run tests',TEAL,'done'],['○','deploy',FAINT,'queued']]
export function MercuryTasks(){return (
  <Box flexDirection="column" borderStyle="round" borderColor={TERRA} paddingX={1}>
    <Text bold color={TERRA}>{CRAB} background tasks</Text>
    {TK.map(([g,l,c,d]:any,i:number)=>(<Text key={i}><Text color={c}>{g} </Text><Text color={IVORY}>{padTo(l,14)}</Text><Text color={FAINT}>{d}</Text></Text>))}
    <Text color={FAINT}>{'↑↓ · ↵ open · x stop · esc'}</Text>
  </Box>)}
