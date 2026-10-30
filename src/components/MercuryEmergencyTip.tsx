import { Box, Text } from '../ink.js'
import { AMBER, SAND } from './mercuryPalette.js'

export function MercuryEmergencyTip({tip='press esc to interrupt a run'}:{tip?:string}){return (
  <Box borderStyle="round" borderColor={AMBER} paddingX={1}><Text><Text color={AMBER}>{'▲'}</Text> <Text color={SAND}>{tip}</Text></Text></Box>)}
