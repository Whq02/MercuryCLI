import * as React from 'react'
import { Text } from '../ink.js'
import { CRIMSON, IVORY, OASIS, TEAL } from './mercuryPalette.js'
import { GLYPH } from './mercury-ui/glyphs.js'

export function MercuryPrBadge({num=128,state='open'}:{num?:number;state?:string}){const c=state==='merged'?OASIS:state==='closed'?CRIMSON:TEAL;return (<Text><Text color={c}>{GLYPH.branch}</Text> <Text color={IVORY}>{'#'+num}</Text> <Text color={c}>{' '+state}</Text></Text>)}
