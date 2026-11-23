#!/usr/bin/env bun
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const selectionBandWhere = 'to fix: deriveSelectionBand and the selectionBand token in resolveMercuryTokens, src/screen/theme/mercuryTokens.ts (change the derived band so it keeps its contrast, follows the accent and differs from surface1, surface2, selection and the raw accent)'
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail || !cond ? ` — ${detail}${!cond ? `${detail ? ' · ' : ''}${selectionBandWhere}` : ''}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' Selection band — LUSTRE L2, the one decisive cursor paint')
console.log('============================================================')

const tokensMod = await import('../../src/screen/theme/mercuryTokens.js')
const themeMod = await import('../../src/screen/theme/theme.js')
const brand = await import('../../src/screen/theme/mercuryPalette.js')
const accentMod = await import('../../src/screen/widgets/sessionAccent.js')

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


console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
