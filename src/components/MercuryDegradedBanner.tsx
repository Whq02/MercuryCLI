import { Box, Text } from '../ink.js'
import { AMBER, SAND } from './mercuryPalette.js'

export function MercuryDegradedBanner({down=2}:{down?:number}){return (<Box borderStyle="round" borderColor={AMBER} paddingX={1}><Text><Text color={AMBER}>{'▲'}</Text> <Text color={SAND}>{' degraded — '+down+' subsystems down · core ok'}</Text></Text></Box>)}
