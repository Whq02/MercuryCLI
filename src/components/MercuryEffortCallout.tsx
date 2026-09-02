import * as React from 'react'
import { Box, Text } from '../ink.js'
import { CRIMSON, FAINT, IVORY, OASIS, SAND, TEAL, TERRA } from './mercuryPalette.js'
import { getSessionAccent } from './mercury-ui/sessionAccent.js'
import { CRAB_GLYPHS as CRAB } from './mercury-ui/assets.js';

export function MercuryEffortCallout({effort='supercode'}:{effort?:string}){return (<Text color={getSessionAccent().accent}>{'— '+effort+' —'}</Text>)}
