import * as React from 'react'
import { Box, Text } from '../ink.js'
import { FAINT, TERRA } from './mercuryPalette.js'
import { TEARDROP_ASTERISK } from '../constants/figures.js'

export function MercurySpinnerLine({verb='Sprouting',secs=6,tokens='—'}:{verb?:string;secs?:number;tokens?:string}){return (
  <Text><Text color={TERRA}>{TEARDROP_ASTERISK}</Text> <Text bold color={TERRA}>{verb}{'…'}</Text> <Text color={FAINT}>{' ('+secs+'s · '+tokens+' tokens · thinking)'}</Text></Text>)}
