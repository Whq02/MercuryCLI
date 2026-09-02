import * as React from 'react'
import { Box, Text } from '../ink.js'
import { AMBER, CLAW, CRIMSON, FAINT, IVORY, OASIS, SAND, TEAL, TERRA } from './mercuryPalette.js'
import { CRAB_GLYPHS as CRAB } from './mercury-ui/assets.js';

export function MercuryPermissionCard({tool='Bash',action='npm install',risk='medium'}:{tool?:string;action?:string;risk?:string}){
  const rc=risk==='high'?CRIMSON:risk==='low'?TEAL:AMBER
  return (<Box flexDirection="column" borderStyle="round" borderColor={AMBER} paddingX={1}>
    <Text><Text color={AMBER}>{'⦿'}</Text> <Text bold color={IVORY}>Permission</Text> <Text color={FAINT}>{'· '}{tool}</Text> <Text color={rc}>[{risk}]</Text></Text>
    <Text color={SAND}>{action}</Text>
    <Box height={1}/>
    <Text color={FAINT}><Text color={TEAL}>[y]</Text> allow  <Text color={TEAL}>[a]</Text> always  <Text color={CRIMSON}>[n]</Text> deny  <Text color={FAINT}>[esc]</Text></Text>
  </Box>)}
