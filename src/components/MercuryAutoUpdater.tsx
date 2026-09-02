import * as React from 'react'
import { Box, Text } from '../ink.js'
import { AMBER, CRIMSON, FAINT, IVORY, OASIS, SAND, TEAL, TERRA } from './mercuryPalette.js'
import { CRAB_GLYPHS as CRAB } from './mercury-ui/assets.js';

export function MercuryAutoUpdater({version='1.0.0-beta.1'}:{version?:string}){return (<Text><Text color={TEAL}>{'●'}</Text> <Text color={SAND}>{' updated to '+version+' · restart to apply'}</Text></Text>)}
