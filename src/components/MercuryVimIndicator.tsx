import { Box, Text } from '../ink.js'
import { AMBER, TEAL, TERRA } from './mercuryPalette.js'

export function MercuryVimIndicator({mode='NORMAL'}:{mode?:string}){
  const c=mode==='INSERT'?TEAL:mode==='VISUAL'?AMBER:TERRA
  return (<Box><Text color={c} bold>{'-- '+mode+' --'}</Text></Box>)}
