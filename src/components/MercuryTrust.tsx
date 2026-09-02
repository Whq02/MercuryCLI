import { homedir } from 'node:os'
import * as React from 'react'
import { Box, Text } from '../ink.js'
import { getCwd } from '../utils/cwd.js'
import { AMBER, CLAW, CRIMSON, FAINT, IVORY, OASIS, SAND, TEAL, TERRA } from './mercuryPalette.js'
import { CRAB_GLYPHS as CRAB } from './mercury-ui/assets.js';

/** The folder the dialog names — the live cwd, home-relative (the specimen
 *  never paints a folder that is not on this machine). */
function cwdLabel(): string {
  const cwd = getCwd()
  const home = homedir()
  return cwd.startsWith(home) ? `~${cwd.slice(home.length)}` || '~' : cwd
}

export function MercuryTrust({path=cwdLabel()}:{path?:string}){return (
  <Box flexDirection="column" borderStyle="round" borderColor={AMBER} paddingX={1}>
    <Text><Text color={AMBER}>{'▲'}</Text> <Text bold color={IVORY}>Trust this folder?</Text></Text>
    <Text color={SAND}>{path}</Text>
    <Text color={FAINT}>Mercury will read & run code here.</Text>
    <Box height={1}/>
    <Text><Text color={TEAL}>[1]</Text> <Text color={IVORY}>trust</Text>   <Text color={CRIMSON}>[2]</Text> <Text color={SAND}>no, exit</Text></Text>
  </Box>)}
