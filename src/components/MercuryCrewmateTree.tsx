import figures from 'figures'
import { Box, Text } from '../ink.js'
import { AMBER, FAINT, IVORY, TERRA } from './mercuryPalette.js'
import { CRITTERS, useSessionAccent } from './mercury-ui/sessionAccent.js'

const TM=[['main',IVORY],['atlas',TERRA],['beacon',AMBER],['cypher',CRITTERS.jellyfish!.accent]]
export function MercuryCrewmateTree({sel=0}:{sel?:number}){
  const accent = useSessionAccent().accent
  return (
  <Box flexDirection="column"><Text color={FAINT}>{'crew · ^t^c'}</Text>
  {TM.map(([n,c]:any,i:number)=>(<Text key={n}><Text color={i===sel?accent:FAINT}>{i===sel?`${figures.pointer} `:'  '}</Text><Text color={c}>{'@'+n}</Text></Text>))}</Box>)}
