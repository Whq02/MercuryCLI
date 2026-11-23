#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { GLYPH } from '../../src/screen/theme/glyphs.ts'
import { BELLY, TERRA } from '../../src/screen/theme/mercuryPalette.ts'
import { resolveMercuryTokens } from '../../src/screen/theme/mercuryTokens.ts'
import { checker } from '../engine-durability/harness.ts'

const t = checker()

t.section('§1 — the branch glyph is vocabulary (D13)')
{
  t.check('GLYPH.branch owns the marker', GLYPH.branch === '⌥', GLYPH.branch)
}

t.section('§2 — the sigil sparkles derive (D12)')
{
  const crab = resolveMercuryTokens('dark', TERRA)
  t.check(
    'the crab sparkle is BYTE-EQUAL to the authored BELLY (the adjudication cost the crab nothing)',
    crab.accentSoft === BELLY,
    `${crab.accentSoft} vs ${BELLY}`,
  )
  const oct = resolveMercuryTokens('dark', '#7755EE')
  t.check(
    'a non-crab critter sparkles its OWN bloom (the cross-family class is closed)',
    oct.accentSoft !== BELLY,
    oct.accentSoft,
  )
}


t.finish('prove-finish-census')
