import * as React from 'react'
import { Box, Text } from '../ink.js'
import { CRIMSON, FAINT, TERRA } from './mercuryPalette.js'
import { GLYPH } from './mercury-ui/glyphs.js'

export function MercuryPromptFooter({mode='implement',branch='main',bypass=false}:{mode?:string;branch?:string;bypass?:boolean}){return (
  <Box>
    <Text color={FAINT}>[<Text color={TERRA}>{mode}</Text>] </Text>
    <Text color={FAINT}>{GLYPH.branch}{branch} </Text>
    {bypass?<Text bold color={CRIMSON}>{'▸▸ sovereign '}</Text>:null}
    <Text color={FAINT}>{'· ↵ send · / cmd · ^t tasks · esc'}</Text>
  </Box>)}
