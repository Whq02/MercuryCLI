import * as React from 'react'
import { Box, Text } from '../ink.js'
import { AMBER, CRIMSON, FAINT, IVORY, OASIS, SAND, TEAL, TERRA } from './mercuryPalette.js'
import { CRAB_GLYPHS as CRAB } from './mercury-ui/assets.js';

export function MercuryRemoteCallout({on=true}:{on?:boolean}){return on?(<Text><Text color={TEAL}>{'●'}</Text> <Text color={TEAL}>{' Remote Control active'}</Text></Text>):null}
