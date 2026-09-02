#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { GLYPH } from '../../src/components/mercury-ui/glyphs.ts'
import { BELLY, TERRA } from '../../src/components/mercuryPalette.ts'
import { resolveMercuryTokens } from '../../src/utils/mercuryTokens.ts'
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const ROOT = join(import.meta.dir, '..', '..')

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, e)
    const st = statSync(join(ROOT, rel))
    if (st.isDirectory()) yield* walk(rel)
    else if (/\.(ts|tsx)$/.test(e)) yield rel
  }
}

t.section('§1 — the branch glyph is vocabulary (D13)')
{
  t.check('GLYPH.branch owns the marker', GLYPH.branch === '⌥', GLYPH.branch)
  const offenders: string[] = []
  for (const rel of [...walk('src/components'), ...walk('src/utils')]) {
    const raw = readFileSync(join(ROOT, rel), 'utf8')
    if (!raw.includes('⌥')) continue
    if (rel.endsWith('mercury-ui/glyphs.ts')) continue
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    for (const [i, line] of src.split('\n').entries()) {
      if (!line.includes('⌥')) continue
      const trimmed = line.trim()
      const comment = trimmed.startsWith('//') || trimmed.startsWith('*')
      const chordHint =
        (rel.endsWith('mercury-ui/SessionTabs.tsx') && line.includes('⌥←→')) ||
        (rel.endsWith('cockpit/companionWords.ts') && line.includes('⌥←→')) ||
        (rel.endsWith('concourse/AttachedSessionScreen.tsx') && line.includes('⌥ drag')) ||
        rel.endsWith('mercury-ui/keyHintLabel.ts')
      if (!comment && !chordHint) offenders.push(`${rel}:${i + 1}`)
    }
  }
  t.check(
    'no raw branch-marker folklore outside the owner (comments + the chord hint excepted)',
    offenders.length === 0,
    offenders.join(', ') || 'clean',
  )
  const promoted = [
    'src/components/MercuryHome.tsx',
    'src/components/mercury-ui/parity/RealmsView.tsx',
    'src/components/DeckPane.tsx',
    'src/components/MercuryFullscreen.tsx',
    'src/components/Deck.tsx',
    'src/components/MercuryPromptFooter.tsx',
    'src/components/BootSettingsScreen.tsx',
  ]
  const missing = promoted.filter(p => !readFileSync(join(ROOT, p), 'utf8').includes('GLYPH.branch'))
  t.check(
    'every promoted site consumes GLYPH.branch',
    missing.length === 0,
    missing.join(', ') || `${promoted.length} sites`,
  )
}

t.section('§2 — the sigil sparkles derive (D12)')
{
  const assets = readFileSync(join(ROOT, 'src/components/mercury-ui/assets.tsx'), 'utf8')
  t.check(
    'sparkles ride tokens.accentSoft',
    /ch === '✦' \|\| ch === '✶'\s*\?\s*t\.accentSoft/.test(assets),
    'SigilRow',
  )
  t.check('assets.tsx imports no fixed BELLY', !/import \{[^}]*BELLY/.test(assets), 'imports')
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

t.section('§3 — the crew estate adds no raw animation clocks')
{
  const estate = ['src/components/prompts-panel', 'src/components/mercury-ui/screens']
  const found: string[] = []
  for (const dir of estate) {
    for (const rel of walk(dir)) {
      const src = readFileSync(join(ROOT, rel), 'utf8')
      for (const [i, line] of src.split('\n').entries()) {
        if (/\bsetInterval\(/.test(line) && !line.trim().startsWith('//')) found.push(`${rel}:${i + 1}`)
      }
    }
  }
  t.check(
    "exactly the ONE allowlisted interval (TeammateChatsView's enabled-gated 2s data poll)",
    found.length === 1 && (found[0] ?? '').includes('TeammateChatsView'),
    found.join(', ') || 'none',
  )
}

t.section('§4 — honest-unavailable tripwire (crew estate)')
{
  const consumers = [
    'src/components/prompts-panel/PromptsPanel.tsx',
    'src/components/mercury-ui/screens/SettingsStatusView.tsx',
    'src/components/mercury-ui/screens/SessionManagerView.tsx',
  ]
  const dishonest = consumers.filter(p => {
    const src = readFileSync(join(ROOT, p), 'utf8')
    return src.includes('unavailable={') && !src.includes('reasonUnavailable')
  })
  t.check(
    'no crew InteractiveRow consumer passes unavailable without a reason',
    dishonest.length === 0,
    dishonest.join(', ') || 'clean',
  )
}

t.finish('prove-finish-census')
