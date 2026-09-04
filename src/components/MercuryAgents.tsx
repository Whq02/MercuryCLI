import * as React from 'react'
import { Box, Text } from '../ink.js'
import { AMBER, CLAW, CRIMSON, FAINT, IVORY, OASIS, SAND, TEAL, TERRA } from './mercuryPalette.js'
import { padTo } from './mercury-ui/glyphs.js'
import { CRAB_GLYPHS as CRAB } from './mercury-ui/assets.js';
import { parseUserSpecifiedModel, renderModelName } from '../utils/model/model.js'

const tier=(alias:string):string=>renderModelName(parseUserSpecifiedModel(alias))
export function MercuryAgents(){const AG=[['orchestrator',tier('fable'),'all tools',TERRA],['api-worker',tier('opus'),'edit,bash',TEAL],['verifier',tier('haiku'),'read-only',OASIS]]; return (
  <Box flexDirection="column" borderStyle="round" borderColor={TERRA} paddingX={1}>
    <Text bold color={TERRA}>{CRAB} agents</Text>
    {AG.map(([n,m,t,c]:any)=>(<Text key={n}><Text color={c}>{'◆ '}</Text><Text color={IVORY}>{padTo(n,14)}</Text><Text color={SAND}>{padTo(m,11)}</Text><Text color={FAINT}>{t}</Text></Text>))}
    <Text color={FAINT}>{'↑↓ · ↵ edit · n new · esc'}</Text>
  </Box>)}
