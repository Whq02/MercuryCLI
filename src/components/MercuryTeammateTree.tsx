import figures from 'figures'
import * as React from 'react'
import { Box, Text } from '../ink.js'
import { AMBER, CRIMSON, FAINT, IVORY, OASIS, SAND, TEAL, TERRA } from './mercuryPalette.js'
import { CRITTERS, useSessionAccent } from './mercury-ui/sessionAccent.js'
import { CRAB_GLYPHS as CRAB } from './mercury-ui/assets.js';

const TM=[['main',IVORY],['atlas',TERRA],['beacon',AMBER],['cypher',CRITTERS.jellyfish!.accent]]
export function MercuryTeammateTree({sel=0}:{sel?:number}){
  // The selection cursor follows the LIVE session accent (re-tints per critter);
  // the per-teammate colors in TM stay each a fixed critter-identity hue
  // (atlas=crab/TERRA, cypher=jellyfish) — and are tokens, not raw hex.
  const accent = useSessionAccent().accent
  return (
  <Box flexDirection="column"><Text color={FAINT}>{'crew · ^t^c'}</Text>
  {TM.map(([n,c]:any,i:number)=>(<Text key={n}><Text color={i===sel?accent:FAINT}>{i===sel?`${figures.pointer} `:'  '}</Text><Text color={c}>{'@'+n}</Text></Text>))}</Box>)}
