import figures from 'figures'
import * as React from 'react'
import { Box, Text } from '../ink.js'
import { AMBER, CLAW, CRIMSON, FAINT, IVORY, OASIS, SAND, TEAL, TERRA } from './mercuryPalette.js'
import { padTo } from './mercury-ui/glyphs.js'
import { CRAB_GLYPHS as CRAB } from './mercury-ui/assets.js';

const FMT=[['markdown','.md',TEAL],['json','.json',FAINT],['html','.html',FAINT]]
export function MercuryExport({sel=0}:{sel?:number}){return (
  <Box flexDirection="column" borderStyle="round" borderColor={TERRA} paddingX={1}>
    <Text bold color={TERRA}>{CRAB} export transcript</Text>
    {FMT.map(([n,e,c]:any,i:number)=>(<Text key={n}><Text color={i===sel?TERRA:FAINT}>{i===sel?`${figures.pointer} `:'  '}</Text><Text color={i===sel?IVORY:SAND}>{padTo(n,10)}</Text><Text color={FAINT}>{e}</Text></Text>))}
    <Text color={FAINT}>{'↑↓ · ↵ save · esc'}</Text>
  </Box>)}
