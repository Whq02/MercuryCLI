#!/usr/bin/env bun
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')

console.log('============================================================')
console.log(' Selection band — LUSTRE L2, the one decisive cursor paint')
console.log('============================================================')

const tokensMod = await import('../../src/utils/mercuryTokens.js')
const themeMod = await import('../../src/utils/theme.js')
const brand = await import('../../src/components/mercuryPalette.js')
const accentMod = await import('../../src/components/mercury-ui/sessionAccent.js')

const CRAB = brand.TERRA
const OCTOPUS = '#7A5FBE'

section('§1 — the central contrast law, EVERY real accent × every derivable family')
{
  const accents = new Map<string, string>()
  for (const c of Object.values(accentMod.CRITTERS)) {
    accents.set(c.key, c.accent)
  }
  for (const family of themeMod.THEME_NAMES) {
    const theme = themeMod.getTheme(family)
    let worstMuted = Infinity
    let worstPrimary = Infinity
    let worstAt = ''
    let derivable = false
    let collapsed = true
    for (const [name, accent] of accents) {
      const t = tokensMod.resolveMercuryTokens(family, accent)
      const muted = tokensMod.contrastRatio(t.selectionBand, t.textMuted)
      const primary = tokensMod.contrastRatio(t.selectionBand, t.textPrimary)
      if (muted === null || primary === null) {
        collapsed = collapsed && t.selectionBand === theme.selectionBg
        continue
      }
      derivable = true
      if (muted < worstMuted) {
        worstMuted = muted
        worstAt = name
      }
      if (primary < worstPrimary) worstPrimary = primary
    }
    if (derivable) {
      check(
        `${family}: muted ≥ 3.0, primary ≥ 6.0 across ${accents.size} real accents`,
        worstMuted >= 3.0 && worstPrimary >= 6.0,
        `worst muted ${worstMuted.toFixed(2)} @ ${worstAt} · worst primary ${worstPrimary.toFixed(2)}`,
      )
    } else {
      check(`${family}: 16-color collapse onto the family selectionBg`, collapsed)
    }
  }
}

section('§2 — accent-following, distinct from the quiet states')
{
  const crab = tokensMod.resolveMercuryTokens('dark', CRAB)
  const octo = tokensMod.resolveMercuryTokens('dark', OCTOPUS)
  check('the band follows the accent (crab ≠ octopus)', crab.selectionBand !== octo.selectionBand)
  check('band ≠ hover surface2', crab.selectionBand !== crab.surface2)
  check('band ≠ the quiet selection wash', crab.selectionBand !== crab.selection)
  check('band ≠ surface1 (a plain panel fill can never read selected)', crab.selectionBand !== crab.surface1)
  check(
    'the band is DERIVED, never the raw accent (a full-saturation row would swallow its ink)',
    crab.selectionBand !== crab.accent && crab.selectionBand !== brand.TERRA,
  )
}

section('§3 — the owner paints CURSOR rows only')
{
  const rowSrc = readFileSync(join(ROOT, 'src/components/mercury-ui/InteractiveRow.tsx'), 'utf-8')
  check('band condition requires selected && focused', /bandPainted\s*=[\s\S]*?selected\s*&&[\s\S]*?focused/.test(rowSrc))
  check('directActivate controls never band', /bandPainted\s*=[\s\S]*?!directActivate/.test(rowSrc))
  check('function-children surfaces never band', /bandPainted\s*=[\s\S]*?typeof children !== 'function'/.test(rowSrc))
  check('unavailable rows never band', /bandPainted\s*=[\s\S]*?!unavailable/.test(rowSrc))
  check(
    'the band OUTRANKS hover (bandPainted resolves before the surface2 branch)',
    /backgroundColor=\{\s*bandPainted\s*\?\s*tokens\.selectionBand/.test(rowSrc),
  )
  check('callers can opt a bespoke-selected surface out', /selectionBand\s*=\s*true/.test(rowSrc))
}

section('§4 — colors only (the no-reflow law)')
{
  const rowSrc = readFileSync(join(ROOT, 'src/components/mercury-ui/InteractiveRow.tsx'), 'utf-8')
  const geometryTouch = /(width|height|padding|margin|flexGrow|flexShrink)\s*=\{[^}]*bandPainted/.test(rowSrc)
  check('bandPainted feeds backgroundColor and nothing geometric', !geometryTouch)
}

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
