import { homedir } from 'node:os'
import { Box, Text } from '../ink.js'
import { getCwd } from '../utils/cwd.js'
import { toTildePath } from '../utils/path.js'
import { AMBER, CRIMSON, FAINT, IVORY, SAND, TEAL } from './mercuryPalette.js'

function cwdLabel(): string {
  const cwd = getCwd()
  const home = homedir()
  return cwd === home ? '~' : toTildePath(cwd)
}

export function MercuryTrust({path=cwdLabel()}:{path?:string}){return (
  <Box flexDirection="column" borderStyle="round" borderColor={AMBER} paddingX={1}>
    <Text><Text color={AMBER}>{'▲'}</Text> <Text bold color={IVORY}>Trust this folder?</Text></Text>
    <Text color={SAND}>{path}</Text>
    <Text color={FAINT}>Mercury will read & run code here.</Text>
    <Box height={1}/>
    <Text><Text color={TEAL}>[1]</Text> <Text color={IVORY}>trust</Text>   <Text color={CRIMSON}>[2]</Text> <Text color={SAND}>no, exit</Text></Text>
  </Box>)}
