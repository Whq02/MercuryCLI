import * as React from 'react'
import { Box, Text } from '../ink.js'
import { AMBER, CLAW, CRIMSON, FAINT, IVORY, OASIS, SAND, TEAL, TERRA } from './mercuryPalette.js'
import { CRAB_GLYPHS as CRAB } from './mercury-ui/assets.js';

const PLAN=['read the gate helpers','add a Substrate section to /deck','wire each capability with an honest ON/OFF']
export function MercuryPlanApproval(){return (
  <Box flexDirection="column" borderStyle="round" borderColor={TERRA} paddingX={1}>
    <Text bold color={TERRA}>{CRAB} plan</Text>
    {PLAN.map((p,i)=>(<Text key={i}><Text color={TEAL}>{(i+1)+'. '}</Text><Text color={IVORY}>{p}</Text></Text>))}
    <Box height={1}/>
    <Text><Text color={TEAL}>[a]</Text> approve  <Text color={AMBER}>[e]</Text> edit  <Text color={CRIMSON}>[r]</Text> reject</Text>
  </Box>)}
