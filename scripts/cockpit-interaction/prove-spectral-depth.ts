#!/usr/bin/env bun
import { vshotBudgetMs } from '../lib/captureDriver.ts'
// ============================================================================
//  scripts/cockpit-interaction/prove-spectral-depth.ts — bounded spectral depth, and the
//  floors that keep it honest.
//
//  The flat-terminal rule, refined: depth should sit between three
//  restrained bands and a smooth gradient. The danger in that permission is a
//  ramp that fades into an unreadable smear on somebody else's ground, or one
//  that quietly becomes the only carrier of a state. So every ramp here is
//  bounded (five named stops), contrast-floored against its OWN family ground,
//  static, and collapses to a single stop where the family cannot host depth.
//
//    §1 the ramp contract      §2 every family, every capability
//    §3 the doctrine is amended at the source of truth, not in a component
//    §4 REAL RENDER: the gauge paints depth in truecolor and one flat tone
//       on a 16-colour family
//
//  The guarded gap: a tree with no spectralRamp, no `spectral` token
//  group, and a design system saying "no gradients" flat.
// ============================================================================

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '1.0.0',
  ISSUES_EXPLAINER: '',
  PACKAGE_URL: '',
  README_URL: '',
  IS_DEV: false,
  IS_DEMO: false,
}

const SELF = new URL(import.meta.url).pathname

// ── child: render gauges under real Ink, then exit ──────────────────────────
if (process.env.SPECTRAL_RENDER_CHILD) {
  const React = await import('react')
  const { render, Box } = (await import('../../src/ink.js')) as {
    render: (n: React.ReactNode) => Promise<unknown>
    Box: React.ComponentType<Record<string, unknown>>
  }
  const { ProgressBar } = await import('../../src/components/mercury-ui/components.js')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
  // The family under test arrives through MERCURY_THEME_PIN — the capture
  // seam built for exactly this (drive every appearance family without
  // touching the operator's config home). Without a ThemeProvider, useTheme()
  // returns its no-provider default and every family would render as dark.
  void render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(ProgressBar, { value: 100, max: 100, width: 12 }),
        // The PARTIAL bar (review finding 6): at 100% any implementation
        // fills `width` cells — 40% is where a ramp-aware fill could diverge
        // between colour modes, so the equal-length law is asserted there too.
        React.createElement(ProgressBar, { value: 40, max: 100, width: 12 }),
      ),
    ),
  )
  setTimeout(() => process.exit(0), 900)
} else {
  const { spawnSync } = await import('node:child_process')
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { checker } = await import('../engine-durability/harness.ts')
  const {
    contrastRatio,
    isDarkThemeFamily,
    resolveMercuryTokens,
    spectralRamp,
    SPECTRAL_STOPS,
    SPECTRAL_STATE_FLOOR,
    SPECTRAL_STRUCTURE_FLOOR,
  } = await import('../../src/utils/mercuryTokens.ts')
  type ThemeName = Parameters<typeof resolveMercuryTokens>[0]

  const t = checker()
  const scratch = mkdtempSync(join(tmpdir(), 'hz-spectral-'))

  // ──────────────────────────────────────────────────────────────────────────
  t.section('§1 — the ramp contract')
  {
    const GROUND = '#12181d'
    const ramp = spectralRamp('#dd4444', GROUND)
    t.check(`a hostable ramp has ${SPECTRAL_STOPS} stops`, ramp.length === SPECTRAL_STOPS, `${ramp.length}`)
    t.check('bounded — the deep end IS the role hue', ramp.at(-1) === '#dd4444', String(ramp.at(-1)))
    t.check(
      'every stop clears the graphical-object floor against its own ground',
      ramp.every(stop => (contrastRatio(stop, GROUND) ?? 0) >= SPECTRAL_STATE_FLOOR),
      ramp.map(s => (contrastRatio(s, GROUND) ?? 0).toFixed(2)).join(' · '),
    )
    t.check(
      'and contrast rises monotonically — quiet to full, never a wobble',
      ramp.every((stop, i) => i === 0 || (contrastRatio(stop, GROUND) ?? 0) >= (contrastRatio(ramp[i - 1]!, GROUND) ?? 0)),
      'monotone',
    )
    t.check('the stops are distinct — five bands, not one repeated', new Set(ramp).size === ramp.length, `${new Set(ramp).size}`)
    t.check(
      'the same inputs give the same ramp',
      spectralRamp('#dd4444', GROUND).join() === ramp.join(),
      'deterministic',
    )

    // A role that cannot clear the floor anywhere in the walk gets ONE honest
    // stop rather than five illegible ones.
    const invisible = spectralRamp('#13191e', GROUND)
    t.check(
      'a role too close to its ground collapses to a single stop',
      invisible.length === 1,
      JSON.stringify(invisible),
    )
    const named = spectralRamp('ansi:yellow', GROUND)
    t.check('and a named 16-colour role cannot host depth at all', named.length === 1, JSON.stringify(named))
    t.check(
      'structure clears a LOWER floor than state — chrome recedes, state is seen',
      SPECTRAL_STRUCTURE_FLOOR < SPECTRAL_STATE_FLOOR,
      `${SPECTRAL_STRUCTURE_FLOOR} < ${SPECTRAL_STATE_FLOOR}`,
    )
  }

  // ──────────────────────────────────────────────────────────────────────────
  t.section('§2 — every family, every capability')
  {
    const FAMILIES: ThemeName[] = [
      'dark',
      'light',
      'dark-daltonized',
      'light-daltonized',
      'dark-ansi',
      'light-ansi',
    ]
    const ROLES = ['oasis', 'terra', 'dune', 'amber', 'crimson'] as const
    for (const family of FAMILIES) {
      const tokens = resolveMercuryTokens(family, '#DD4444')
      t.check(`${family}: names all five ramps`, ROLES.every(r => tokens.spectral[r] !== undefined), ROLES.join(','))
      const ground = tokens.surface0
      for (const role of ROLES) {
        const ramp = tokens.spectral[role]
        // PER-ROLE floor (review finding 5): dune is the one structure ramp
        // (1.5 — chrome recedes); every STATE ramp owes the 3.0 state floor,
        // and an unparseable colour FAILS instead of hiding behind Infinity.
        const floor = role === 'dune' ? SPECTRAL_STRUCTURE_FLOOR : SPECTRAL_STATE_FLOOR
        t.check(
          `${family}/${role}: every stop clears its OWN floor (${floor}) on this family's ground`,
          ramp.length === 1 ||
            ramp.every(stop => (contrastRatio(stop, ground) ?? -1) >= floor),
          `${ramp.length} stops`,
        )
        // Monotone quiet→full for EVERY shipped ramp, not the §1 sample pair
        // (re-audit: the contract said monotone, the proof said one ramp).
        t.check(
          `${family}/${role}: contrast rises monotonically across the shipped ramp`,
          ramp.length === 1 ||
            ramp.every(
              (stop, i) =>
                i === 0 ||
                (contrastRatio(stop, ground) ?? 0) >= (contrastRatio(ramp[i - 1]!, ground) ?? 0),
            ),
          ramp.map(s => (contrastRatio(s, ground) ?? 0).toFixed(2)).join(' · '),
        )
      }
      // The structural equivalent: a family that cannot host depth says so by
      // ramp LENGTH, which is what every consumer branches on — so a 16-colour
      // or no-colour profile falls back to flat rendering rather than painting
      // an approximation of a ramp.
      const ansi = family.endsWith('-ansi')
      if (ansi) {
        t.check(
          `${family}: every ramp collapses — a 16-colour profile is told, not approximated`,
          ROLES.every(r => tokens.spectral[r].length === 1),
          ROLES.map(r => tokens.spectral[r].length).join(','),
        )
      }
      t.check(
        `${family}: the identity ramp follows the SESSION accent, not a fixed brand hue`,
        resolveMercuryTokens(family, '#33AACC').spectral.terra.at(-1) !== tokens.spectral.terra.at(-1) ||
          tokens.spectral.terra.length === 1,
        'per-critter depth',
      )
      t.check(
        `${family}: dark-family classification is consistent`,
        typeof isDarkThemeFamily(family) === 'boolean',
        String(isDarkThemeFamily(family)),
      )
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  t.section('§3 — the doctrine is amended at the source of truth')
  {
    const readme = readFileSync('design-system/readme.md', 'utf8')
    t.check('the readme still forbids shadows', /no\s*\n?shadows/.test(readme), 'flat')
    // (The readme states the present-tense doctrine — the bound below — and
    // carries no amendment narration: the comment-provenance law.)
    t.check(
      'naming the bound (five discrete stops) rather than "gradients allowed"',
      /five\*{0,2} discrete stops/.test(readme),
      'bounded',
    )
    t.check(
      'and pointing at the token owner so a local literal stays forbidden',
      readme.includes('src/utils/mercuryTokens.ts') && readme.includes('local literal gradient is still forbidden'),
      'one owner',
    )
    const tokens = readFileSync('src/utils/mercuryTokens.ts', 'utf8')
    t.check(
      'the ramp is STATIC — no timer, no animation, in the token path',
      !/setInterval|setTimeout|requestAnimationFrame/.test(tokens),
      'no continued writes',
    )
    const kit = readFileSync('src/components/mercury-ui/components.tsx', 'utf8')
    t.check(
      'the consuming surface reads the shared ramp, never its own mix',
      kit.includes('spectralRampFor(color, t.surface0)'),
      'shared',
    )
    t.check(
      'and falls back to the flat fill when the family cannot host depth',
      kit.includes('const flat = ramp.length === 1'),
      'declared fallback',
    )
  }

  // ──────────────────────────────────────────────────────────────────────────
  t.section('§4 — REAL RENDER: depth in truecolor, one flat tone at 16 colours')
  {
    const capture = (theme: string, label: string): string[] => {
      const out = join(scratch, `${label}.json`)
      const cfg = join(scratch, `${label}-cfg.json`)
      writeFileSync(
        cfg,
        JSON.stringify({
          argv: [process.execPath, 'run', SELF],
          sends: [],
          total: 14,
          cols: 40,
          rows: 4,
          out,
        }),
      )
      const r = spawnSync('/usr/bin/python3', ['scripts/ui/vshot.py', cfg], {
        encoding: 'utf8',
        timeout: vshotBudgetMs(60_000),
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          MERCURY_THEME_PIN: theme,
          SPECTRAL_RENDER_CHILD: '1',
        },
      })
      if (r.status !== 0) return []
      try {
        const payload = JSON.parse(readFileSync(out, 'utf8')) as {
          grid: { c: string; fg: string }[][]
        }
        // Every bar row (full first, partial second), fills per row.
        const rows = payload.grid.filter(cells => cells.some(cell => cell.c === '█'))
        return rows.map(rowCells =>
          rowCells.filter(cell => cell.c === '█').map(cell => String(cell.fg)),
        )
      } catch {
        return []
      }
    }

    const truecolor = capture('dark', 'dark')
    const tcFull = truecolor[0] ?? []
    const tcPartial = truecolor[1] ?? []
    t.check('the gauge rendered (full + partial bars)', tcFull.length >= 8 && tcPartial.length >= 2, `${tcFull.length}/${tcPartial.length} filled cells`)
    t.check(
      'and paints DEPTH — several distinct stops across the track',
      new Set(tcFull).size >= 3,
      `${new Set(tcFull).size} distinct inks: ${[...new Set(tcFull)].join(' ')}`,
    )

    const ansi = capture('dark-ansi', 'ansi')
    const anFull = ansi[0] ?? []
    const anPartial = ansi[1] ?? []
    t.check('the 16-colour gauge rendered (both bars)', anFull.length >= 8 && anPartial.length >= 2, `${anFull.length}/${anPartial.length} filled cells`)
    t.check(
      'and paints ONE flat tone — the fallback, not an approximated ramp',
      new Set(anFull).size === 1,
      `${new Set(anFull).size} distinct inks: ${[...new Set(anFull)].join(' ')}`,
    )
    t.check(
      'the FULL fill length is identical either way',
      tcFull.length === anFull.length,
      `${tcFull.length} vs ${anFull.length}`,
    )
    t.check(
      'the PARTIAL fill length is identical either way — colour never carries the state where it could',
      tcPartial.length === anPartial.length,
      `${tcPartial.length} vs ${anPartial.length}`,
    )
  }

  rmSync(scratch, { recursive: true, force: true })
  t.finish('prove-spectral-depth')
}
