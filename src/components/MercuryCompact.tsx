import * as React from 'react'
import { Box, Text } from '../ink.js'
import { AMBER, FAINT, SAND } from './mercuryPalette.js'

export function MercuryCompact({pct=72}:{pct?:number}){return (
  <Box flexDirection="column">
    <Text><Text color={AMBER}>{'◈'}</Text> <Text color={SAND}>context compacted at {pct}% — older turns summarized</Text></Text>
    <Text color={FAINT}>{'  └─ history preserved · /context to inspect'}</Text>
  </Box>)}
