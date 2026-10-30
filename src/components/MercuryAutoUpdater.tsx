import { Text } from '../ink.js'
import { SAND, TEAL } from './mercuryPalette.js'

export function MercuryAutoUpdater({version='1.0.0-beta.1'}:{version?:string}){return (<Text><Text color={TEAL}>{'●'}</Text> <Text color={SAND}>{' updated to '+version+' · restart to apply'}</Text></Text>)}
