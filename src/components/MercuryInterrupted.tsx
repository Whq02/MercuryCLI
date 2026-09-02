import * as React from 'react'
import { Box, Text } from '../ink.js'
import { AMBER, CRIMSON, FAINT, IVORY, OASIS, SAND, TEAL, TERRA } from './mercuryPalette.js'
import { CRAB_GLYPHS as CRAB } from './mercury-ui/assets.js';

export function MercuryInterrupted(){return (<Text><Text color={AMBER}>{'▲'}</Text> <Text color={SAND}>{' interrupted by operator'}</Text></Text>)}
