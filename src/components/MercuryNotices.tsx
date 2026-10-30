import { Box, Text } from '../ink.js'
import { AMBER, FAINT, SAND, TEAL } from './mercuryPalette.js'

const NT=[['●','update available 1.0.0-beta.1',TEAL],['⦿','crewmates gated',AMBER],['○','3 extensions off',FAINT]]
export function MercuryNotices(){return (
  <Box flexDirection="column">
    {NT.map(([g,t,c]:any,i:number)=>(<Text key={i}><Text color={c}>{g} </Text><Text color={SAND}>{t}</Text></Text>))}
  </Box>)}
