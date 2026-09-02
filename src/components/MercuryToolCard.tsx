import * as React from 'react'
import { Box, Text } from '../ink.js'
import { CRIMSON, FAINT, IVORY, SAND, TEAL } from './mercuryPalette.js'
import { GLYPH } from './mercury-ui/glyphs.js'

export function MercuryToolCard({name='Edit',args='Deck.tsx',out='+318 / -77',state='done'}:{name?:string;args?:string;out?:string;state?:string}){
  const d=state==='run'?{g:'◐',c:TEAL}:state==='err'?{g:GLYPH.fail,c:CRIMSON}:{g:'●',c:TEAL}
  return (<Box flexDirection="column">
    <Text><Text color={d.c}>{d.g}</Text> <Text bold color={IVORY}>{name}</Text> <Text color={SAND}>{args}</Text></Text>
    <Text color={FAINT}>{'  └─ '}{state==='run'?'running…':out}</Text>
  </Box>)}
