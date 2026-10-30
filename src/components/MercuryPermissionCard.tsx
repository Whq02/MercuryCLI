import { Box, Text } from '../ink.js'
import { AMBER, CRIMSON, FAINT, IVORY, SAND, TEAL } from './mercuryPalette.js'

export function MercuryPermissionCard({tool='Bash',action='npm install',risk='medium'}:{tool?:string;action?:string;risk?:string}){
  const rc=risk==='high'?CRIMSON:risk==='low'?TEAL:AMBER
  return (<Box flexDirection="column" borderStyle="round" borderColor={AMBER} paddingX={1}>
    <Text><Text color={AMBER}>{'⦿'}</Text> <Text bold color={IVORY}>Permission</Text> <Text color={FAINT}>{'· '}{tool}</Text> <Text color={rc}>[{risk}]</Text></Text>
    <Text color={SAND}>{action}</Text>
    <Box height={1}/>
    <Text color={FAINT}><Text color={TEAL}>[y]</Text> allow  <Text color={TEAL}>[a]</Text> always  <Text color={CRIMSON}>[n]</Text> deny  <Text color={FAINT}>[esc]</Text></Text>
  </Box>)}
