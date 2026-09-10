import * as React from 'react'
import { Box, Text } from '../ink.js'
import { FAINT, TEAL, TERRA } from './mercuryPalette.js'
import { CRAB_GLYPHS as CRAB, SessionMark } from './mercury-ui/assets.js';
import { parseUserSpecifiedModel, renderModelName } from '../utils/model/model.js'
import { useLayoutChrome } from '../context/layoutChromeContext.js'

export function MercuryStatusline(){const frontier = renderModelName(parseUserSpecifiedModel('fable')); const { isCompact } = useLayoutChrome(); if (isCompact) return <Text color={FAINT} wrap="truncate-end">{frontier} · ctx —</Text>; return (
  <Box flexDirection="column" borderStyle="round" borderColor={TERRA} paddingX={1}>
    <Text bold color={TERRA}>{CRAB} statusline</Text>
    <Text color={FAINT}>preview (the live frame row: critter mark · model · data):</Text>
    <Text><SessionMark /><Text color={FAINT}> {'│'} {frontier} {'│'} ctx </Text><Text color={TEAL}>{'███░░'}</Text></Text>
    <Text color={FAINT}>{'↑↓ toggle segments · esc'}</Text>
  </Box>)}
