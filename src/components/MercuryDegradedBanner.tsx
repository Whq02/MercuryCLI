import * as React from 'react'
import { Box, Text } from '../ink.js'
import { AMBER, CRIMSON, FAINT, IVORY, OASIS, SAND, TEAL, TERRA } from './mercuryPalette.js'
import { CRAB_GLYPHS as CRAB } from './mercury-ui/assets.js';

export function MercuryDegradedBanner({down=2}:{down?:number}){return (<Box borderStyle="round" borderColor={AMBER} paddingX={1}><Text><Text color={AMBER}>{'▲'}</Text> <Text color={SAND}>{' degraded — '+down+' subsystems down · core ok'}</Text></Text></Box>)}
