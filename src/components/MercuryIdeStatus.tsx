import * as React from 'react'
import { Box, Text } from '../ink.js'
import { AMBER, CRIMSON, FAINT, IVORY, OASIS, SAND, TEAL, TERRA } from './mercuryPalette.js'
import { CRAB_GLYPHS as CRAB } from './mercury-ui/assets.js';

export function MercuryIdeStatus({ide='VS Code',connected=true}:{ide?:string;connected?:boolean}){return (<Text><Text color={connected?TEAL:FAINT}>{connected?'●':'○'}</Text> <Text color={FAINT}>{' '+ide+(connected?' connected':' —')}</Text></Text>)}
