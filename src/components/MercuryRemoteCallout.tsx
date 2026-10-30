import { Text } from '../ink.js'
import { TEAL } from './mercuryPalette.js'

export function MercuryRemoteCallout({on=true}:{on?:boolean}){return on?(<Text><Text color={TEAL}>{'●'}</Text> <Text color={TEAL}>{' Remote Control active'}</Text></Text>):null}
