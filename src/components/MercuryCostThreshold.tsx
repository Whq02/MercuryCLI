import * as React from 'react'
import { Box, Text } from '../ink.js'
import { AMBER, CRIMSON, IVORY, SAND, TEAL } from './mercuryPalette.js'

export function MercuryCostThreshold({cost='5.00'}:{cost?:string}){return (
  <Box flexDirection="column" borderStyle="round" borderColor={AMBER} paddingX={1}>
    <Text><Text color={AMBER}>{'▲'}</Text> <Text bold color={IVORY}>Cost checkpoint</Text></Text>
    <Text color={SAND}>{'$'}{cost} this session</Text>
    <Text><Text color={TEAL}>[y]</Text> continue  <Text color={CRIMSON}>[n]</Text> stop</Text>
  </Box>)}
