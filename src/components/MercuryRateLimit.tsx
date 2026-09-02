import * as React from 'react'
import { Box, Text } from '../ink.js'
import { AMBER, CRIMSON, FAINT, IVORY } from './mercuryPalette.js'
import { GLYPH } from './mercury-ui/glyphs.js'

export function MercuryRateLimit({pct=95,resets='14:32'}:{pct?:number;resets?:string}){
  const c=pct>=95?CRIMSON:AMBER
  return (<Box borderStyle="round" borderColor={c} paddingX={1}>
    <Text><Text color={c}>{GLYPH.warn}</Text> <Text color={IVORY}>usage {pct}%</Text> <Text color={FAINT}>· 5h window resets {resets}</Text></Text>
  </Box>)}
