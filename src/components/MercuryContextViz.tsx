import * as React from 'react'
import { Box, Text } from '../ink.js'
import { AMBER, CLAW, CRIMSON, FAINT, IVORY, OASIS, SAND, TEAL, TERRA } from './mercuryPalette.js'
import { padTo } from './mercury-ui/glyphs.js'
import { CRAB_GLYPHS as CRAB } from './mercury-ui/assets.js';

const CV=[['system',12,TEAL],['tools',18,TEAL],['history',32,AMBER],['free',38,FAINT]]
function b(p:number){const f=Math.max(0,Math.min(16,Math.round(p/100*16)));return '█'.repeat(f)+'░'.repeat(16-f)}
export function MercuryContextViz(){return (
  <Box flexDirection="column" borderStyle="round" borderColor={TERRA} paddingX={1}>
    <Text bold color={TERRA}>{CRAB} context {'·'} — / —</Text>
    {CV.map(([n,p,c]:any)=>(<Text key={n}><Text color={FAINT}>{padTo(n,8)}</Text><Text color={c}>{b(p)}</Text><Text color={SAND}> {p}{'%'}</Text></Text>))}
    <Text color={FAINT}>illustrative specimen · esc close</Text>
  </Box>)}
