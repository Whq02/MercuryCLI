import * as React from 'react'
import { Box, Text } from '../ink.js'
import { CRIMSON, FAINT, IVORY, TEAL, TERRA } from './mercuryPalette.js'

export function MercuryShellOutput({cmd='npm test',out='42 passing',ok=true}:{cmd?:string;out?:string;ok?:boolean}){return (
  <Box flexDirection="column">
    <Text><Text color={TERRA}>{'!'}</Text> <Text color={IVORY}>{cmd}</Text></Text>
    <Text color={FAINT}>{'  └─ '}<Text color={ok?TEAL:CRIMSON}>{out}</Text></Text>
  </Box>)}
