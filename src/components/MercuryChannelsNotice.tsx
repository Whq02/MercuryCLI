import * as React from 'react'
import { Box, Text } from '../ink.js'
import { AMBER, CRIMSON, FAINT, IVORY, OASIS, SAND, TEAL, TERRA } from './mercuryPalette.js'
import { CRAB_GLYPHS as CRAB } from './mercury-ui/assets.js';

export function MercuryChannelsNotice(){return (<Text><Text color={OASIS}>{'◈'}</Text> <Text color={SAND}>{'2 channels active · #build #review'}</Text></Text>)}
