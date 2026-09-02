#!/usr/bin/env bun
import { listUnresolvedTokenRoles, resolveMercuryTokens } from '../../src/utils/mercuryTokens.js'
import { THEME_NAMES } from '../../src/utils/theme.js'
import { stateStyleOf, gaugeColorOf, type SnapshotState } from '../../src/components/mercury-ui/theme.js'
import { TERRA } from '../../src/components/mercuryPalette.js'

let fail = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}

const STATES: SnapshotState[] = [
  'live', 'ready', 'starting', 'configured', 'degraded', 'stale', 'off',
  'disabled', 'gated', 'unavailable', 'blocked', 'failed', 'excluded', 'planned',
]

for (const family of THEME_NAMES) {
  const tok = resolveMercuryTokens(family, TERRA)

  const empties = listUnresolvedTokenRoles(tok)
  t(`${family}: every semantic role maps to a nonempty value`, empties.length === 0, empties.join(','))
  const ramps = Object.entries(tok.spectral)
  t(
    `${family}: every spectral ramp has at least one usable stop`,
    ramps.length === 5 &&
      ramps.every(([, ramp]) => ramp.length >= 1 && ramp.every(stop => typeof stop === 'string' && stop.length > 0)),
    ramps.map(([k, ramp]) => `${k}:${ramp.length}`).join(' '),
  )

  const seen = new Map<string, SnapshotState>()
  let colorless = 0
  let collided = ''
  for (const st of STATES) {
    const s = stateStyleOf(tok, st)
    if (!s.color) colorless++
    const key = `${s.glyph}|${s.label}`
    if (seen.has(key)) collided = `${seen.get(key)} vs ${st}`
    seen.set(key, st)
  }
  t(`${family}: every state colours nonempty`, colorless === 0, `${colorless} blank`)
  t(`${family}: states stay distinct with colour stripped (glyph+label unique)`, collided === '', collided)

  t(
    `${family}: gauge ramp = success<80 · warning<95 · failure>=95`,
    gaugeColorOf(tok, 79) === tok.success &&
      gaugeColorOf(tok, 80) === tok.warning &&
      gaugeColorOf(tok, 94) === tok.warning &&
      gaugeColorOf(tok, 95) === tok.failure,
  )

  t(
    `${family}: 8 agent accents resolve nonempty`,
    tok.agentAccents.length === 8 && tok.agentAccents.every(a => a.color && a.name),
  )
}

if (fail) {
  console.log('\n❌ token completeness — failures above')
  process.exit(1)
}
console.log(`\n✅ token completeness — ${THEME_NAMES.length} families × roles/states/gauge/accents`)
