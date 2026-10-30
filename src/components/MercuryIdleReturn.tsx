import { Box, Text } from '../ink.js'
import { SAND, TEAL } from './mercuryPalette.js'

export function MercuryIdleReturn({idle='12m'}:{idle?:string}){return (
  <Box><Text color={TEAL}>{'●'}</Text> <Text color={SAND}>welcome back {'·'} {idle} idle {'·'} session resumed</Text></Box>)}
