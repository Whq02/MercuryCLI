import * as React from 'react'
import { Box, Text } from '../ink.js'
import { AMBER, CRIMSON, FAINT, IVORY, SAND, TEAL, TERRA } from './mercuryPalette.js'
import { Crab } from './mercury-ui/assets.js'

// The welcome/landing card (showcase 'Welcome / splash' specimen). Plain
// register: the old slogan class — "mission control ·
// forged, not wrapped", "state the objective — ↵ dispatches" — is retired
// everywhere; copy says what keys do and nothing else.
export function MercuryWelcome(){return (
  <Box flexDirection="column" borderStyle="round" borderColor={TERRA} paddingX={2} paddingY={1}>
    <Text bold color={TERRA}><Crab/> Mercury</Text>
    <Box height={1}/>
    <Text color={FAINT}>{'•'} type a prompt, or <Text color={TERRA}>/</Text> for commands</Text>
    <Text color={FAINT}>{'•'} <Text color={TERRA}>/deck</Text> opens the command center · <Text color={TERRA}>/critter</Text> themes the session</Text>
    <Text color={FAINT}>{'•'} spine: <Text color={TEAL}>{'●'}</Text> ok <Text color={AMBER}>{'▲'}</Text> warn <Text color={CRIMSON}>{'✕'}</Text> error</Text>
    <Box height={1}/>
    <Text><Text color={TERRA}>{'❯'}</Text> <Text color={IVORY}>↵</Text><Text color={SAND}> sends</Text></Text>
  </Box>)}
