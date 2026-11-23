#!/usr/bin/env bun
import { listUnresolvedTokenRoles, resolveMercuryTokens } from '../../src/screen/theme/mercuryTokens.js'
import { THEME_NAMES } from '../../src/screen/theme/theme.js'
import { stateStyleOf, gaugeColorOf } from '../../src/screen/widgets/theme.js'
import type { SnapshotState } from '../../src/screen/cockpit/types.js'
import { TERRA } from '../../src/screen/theme/mercuryPalette.js'

let fail = 0
const t = (name: string, ok: boolean, detail = '', failHint = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}${!ok && failHint ? ` — ${failHint}` : ''}`)
  if (!ok) fail = 1
}

const STATES: SnapshotState[] = [
  'live', 'ready', 'starting', 'configured', 'degraded', 'stale', 'off',
  'disabled', 'gated', 'unavailable', 'blocked', 'failed', 'excluded', 'planned',
]

for (const family of THEME_NAMES) {
  const tok = resolveMercuryTokens(family, TERRA)

  const empties = listUnresolvedTokenRoles(tok)
  t(`${family}: every semantic role maps to a nonempty value`, empties.length === 0, empties.join(','), 'the roles listed above resolve empty; give them a value in resolveMercuryTokens in src/screen/theme/mercuryTokens.ts for this theme family')
  const ramps = Object.entries(tok.spectral)
  t(
    `${family}: every spectral ramp has at least one usable stop`,
    ramps.length === 5 &&
      ramps.every(([, ramp]) => ramp.length >= 1 && ramp.every(stop => typeof stop === 'string' && stop.length > 0)),
    ramps.map(([k, ramp]) => `${k}:${ramp.length}`).join(' '),
    'resolveMercuryTokens in src/screen/theme/mercuryTokens.ts must return the five spectral ramps (oasis, terra, dune, amber, crimson), each with at least one nonempty stop; see spectralRampFor there',
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
  t(`${family}: every state colours nonempty`, colorless === 0, `${colorless} blank`, 'stateStyleOf in src/screen/widgets/theme.ts reads a token role that resolves empty for some state; fill that role in resolveMercuryTokens (src/screen/theme/mercuryTokens.ts) or fix the STATE_ROLE entry')
  t(`${family}: states stay distinct with colour stripped (glyph+label unique)`, collided === '', collided, 'two states share the same glyph and label in STATE_ROLE in src/screen/widgets/theme.ts; give one of them a distinct glyph or label')

  t(
    `${family}: gauge ramp = success<80 · warning<95 · failure>=95`,
    gaugeColorOf(tok, 79) === tok.success &&
      gaugeColorOf(tok, 80) === tok.warning &&
      gaugeColorOf(tok, 94) === tok.warning &&
      gaugeColorOf(tok, 95) === tok.failure,
    '',
    'gaugeColorOf in src/screen/widgets/theme.ts must return success below 80, warning from 80 to 94, failure from 95',
  )

  t(
    `${family}: 8 agent accents resolve nonempty`,
    tok.agentAccents.length === 8 && tok.agentAccents.every(a => a.color && a.name),
    '',
    'agentAccentsOf in src/screen/theme/mercuryTokens.ts must yield exactly 8 accents, each with a color and a name',
  )
}

if (fail) {
  console.log('\n❌ token completeness — failures above')
  process.exit(1)
}
console.log(`\n✅ token completeness — ${THEME_NAMES.length} families × roles/states/gauge/accents`)
