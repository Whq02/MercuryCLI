import { Text } from '../ink.js'
import { AMBER, SAND } from './mercuryPalette.js'

export function MercuryInterrupted(){return (<Text><Text color={AMBER}>{'▲'}</Text> <Text color={SAND}>{' interrupted by operator'}</Text></Text>)}
