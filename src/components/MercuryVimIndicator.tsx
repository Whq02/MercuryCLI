import * as React from 'react'
import { Box, Text } from '../ink.js'
import { AMBER, CLAW, CRIMSON, FAINT, IVORY, OASIS, SAND, TEAL, TERRA } from './mercuryPalette.js'
import { CRAB_GLYPHS as CRAB } from './mercury-ui/assets.js';

export function MercuryVimIndicator({mode='NORMAL'}:{mode?:string}){
  const c=mode==='INSERT'?TEAL:mode==='VISUAL'?AMBER:TERRA
  return (<Box><Text color={c} bold>{'-- '+mode+' --'}</Text></Box>)}
