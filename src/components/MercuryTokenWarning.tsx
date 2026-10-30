import { Text } from '../ink.js'
import { AMBER, CRIMSON, SAND } from './mercuryPalette.js'
import { GLYPH } from './mercury-ui/glyphs.js'

export function MercuryTokenWarning({pct=92}:{pct?:number}){const blocked=pct>=95;const c=blocked?CRIMSON:AMBER;return (<Text><Text color={c}>{blocked?GLYPH.circledSlash:GLYPH.warn}</Text> <Text color={SAND}>{' context '+pct+'% · consider /compact'}</Text></Text>)}
