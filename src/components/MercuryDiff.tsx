import * as React from 'react'
import { Box, Text } from '../ink.js'
import { CRIMSON, FAINT, IVORY, SAND, TEAL } from './mercuryPalette.js'

const D=[['12',' ','const gate = readGate()','ctx'],['13','-','// TODO substrate','del'],['13','+','<GateRow on={gate} />','add'],['14','+','<SectionHeader>Substrate','add']]
export function MercuryDiff(){return (
  <Box flexDirection="column">
    <Text><Text color={TEAL}>{'●'}</Text> <Text bold color={IVORY}>Update</Text> <Text color={SAND}>Deck.tsx</Text></Text>
    {D.map(([n,p,t,k]:any,i:number)=>(<Text key={i}><Text color={FAINT}>{String(n).padStart(3)} </Text><Text color={k==='add'?TEAL:k==='del'?CRIMSON:SAND}>{p} {t}</Text></Text>))}
  </Box>)}
