#!/usr/bin/env bun
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { fileURLToPath } from 'node:url'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '1.0.0',
  ISSUES_EXPLAINER: '',
  PACKAGE_URL: '',
  README_URL: '',
  IS_DEV: false,
  MERCURY_DEMO: false,
}

const SELF = fileURLToPath(import.meta.url)

if (process.env.SPECTRAL_RENDER_CHILD) {
  const React = await import('react')
  const { render, Box } = (await import('../../src/screen/themedRenderer.js')) as {
    render: (n: React.ReactNode) => Promise<unknown>
    Box: React.ComponentType<Record<string, unknown>>
  }
  const { ProgressBar } = await import('../../src/screen/widgets/components.js')
  const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.js')
  void render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(ProgressBar, { value: 100, max: 100, width: 12 }),
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
  } = await import('../../src/screen/theme/mercuryTokens.ts')
  type ThemeName = Parameters<typeof resolveMercuryTokens>[0]

  const t = checker()
  const checkWithFix = (label: string, cond: boolean, detail: string, fix: string): void =>
    t.check(label, cond, cond ? detail : `${detail} — ${fix}`)
  const scratch = mkdtempSync(join(tmpdir(), 'hz-spectral-'))

  t.section('§1 — the ramp contract')
  {
    const GROUND = '#12181d'
    const ramp = spectralRamp('#dd4444', GROUND)
    checkWithFix(`a hostable ramp has ${SPECTRAL_STOPS} stops`, ramp.length === SPECTRAL_STOPS, `${ramp.length}`, 'change spectralRamp in src/screen/theme/mercuryTokens.ts to return SPECTRAL_STOPS stops for a role that clears the floor')
    checkWithFix('bounded — the deep end IS the role hue', ramp.at(-1) === '#dd4444', String(ramp.at(-1)), 'change spectralRamp in src/screen/theme/mercuryTokens.ts so the last stop is the role colour itself')
    checkWithFix(
      'every stop clears the graphical-object floor against its own ground',
      ramp.every(stop => (contrastRatio(stop, GROUND) ?? 0) >= SPECTRAL_STATE_FLOOR),
      ramp.map(s => (contrastRatio(s, GROUND) ?? 0).toFixed(2)).join(' · '),
      'change spectralRamp in src/screen/theme/mercuryTokens.ts so its first stop starts at the floor (tMin search)',
    )
    checkWithFix(
      'and contrast rises monotonically — quiet to full, never a wobble',
      ramp.every((stop, i) => i === 0 || (contrastRatio(stop, GROUND) ?? 0) >= (contrastRatio(ramp[i - 1]!, GROUND) ?? 0)),
      'monotone',
      'change spectralRamp in src/screen/theme/mercuryTokens.ts so each stop is no darker than the one before',
    )
    checkWithFix('the stops are distinct — five bands, not one repeated', new Set(ramp).size === ramp.length, `${new Set(ramp).size}`, 'change spectralRamp in src/screen/theme/mercuryTokens.ts so no two stops repeat')
    checkWithFix(
      'the same inputs give the same ramp',
      spectralRamp('#dd4444', GROUND).join() === ramp.join(),
      'deterministic',
      'remove any non-deterministic input from spectralRamp in src/screen/theme/mercuryTokens.ts',
    )

    const invisible = spectralRamp('#13191e', GROUND)
    checkWithFix(
      'a role too close to its ground collapses to a single stop',
      invisible.length === 1,
      JSON.stringify(invisible),
      'spectralRamp in src/screen/theme/mercuryTokens.ts must return [role] when no stop reaches the floor',
    )
    const named = spectralRamp('ansi:yellow', GROUND)
    checkWithFix('and a named 16-colour role cannot host depth at all', named.length === 1, JSON.stringify(named), 'spectralRamp in src/screen/theme/mercuryTokens.ts must return [role] when the colour does not parse as a hex value')
    checkWithFix(
      'structure clears a LOWER floor than state — chrome recedes, state is seen',
      SPECTRAL_STRUCTURE_FLOOR < SPECTRAL_STATE_FLOOR,
      `${SPECTRAL_STRUCTURE_FLOOR} < ${SPECTRAL_STATE_FLOOR}`,
      'set SPECTRAL_STRUCTURE_FLOOR below SPECTRAL_STATE_FLOOR in src/screen/theme/mercuryTokens.ts',
    )
  }

  t.section('§2 — every family, every capability')
  {
    const FAMILIES: ThemeName[] = ['dark', 'true-black']
    const ROLES = ['oasis', 'terra', 'dune', 'amber', 'crimson'] as const
    for (const family of FAMILIES) {
      const tokens = resolveMercuryTokens(family, '#DD4444')
      checkWithFix(`${family}: names all five ramps`, ROLES.every(r => tokens.spectral[r] !== undefined), ROLES.join(','), 'add the missing role to the spectral block of resolveMercuryTokens in src/screen/theme/mercuryTokens.ts')
      const ground = tokens.surface0
      for (const role of ROLES) {
        const ramp = tokens.spectral[role]
        const floor = role === 'dune' ? SPECTRAL_STRUCTURE_FLOOR : SPECTRAL_STATE_FLOOR
        checkWithFix(
          `${family}/${role}: every stop clears its OWN floor (${floor}) on this appearance's ground`,
          ramp.length === 1 ||
            ramp.every(stop => (contrastRatio(stop, ground) ?? -1) >= floor),
          `${ramp.length} stops`,
          'check the ground and floor passed to spectralRampFor in the spectral block of resolveMercuryTokens, src/screen/theme/mercuryTokens.ts',
        )
        checkWithFix(
          `${family}/${role}: contrast rises monotonically across the shipped ramp`,
          ramp.length === 1 ||
            ramp.every(
              (stop, i) =>
                i === 0 ||
                (contrastRatio(stop, ground) ?? 0) >= (contrastRatio(ramp[i - 1]!, ground) ?? 0),
            ),
          ramp.map(s => (contrastRatio(s, ground) ?? 0).toFixed(2)).join(' · '),
          'check spectralRamp and the spectral block of resolveMercuryTokens in src/screen/theme/mercuryTokens.ts',
        )
      }
      checkWithFix(
        `${family}: the identity ramp follows the SESSION accent, not a fixed brand hue`,
        resolveMercuryTokens(family, '#33AACC').spectral.terra.at(-1) !== tokens.spectral.terra.at(-1) ||
          tokens.spectral.terra.length === 1,
        'per-critter depth',
        'the terra ramp in resolveMercuryTokens, src/screen/theme/mercuryTokens.ts, must be built from the accent argument',
      )
      checkWithFix(
        `${family}: dark-family classification is consistent`,
        isDarkThemeFamily(family) === true,
        String(isDarkThemeFamily(family)),
        'isDarkThemeFamily in src/screen/theme/mercuryTokens.ts must return true for dark and true-black',
      )
    }
  }


  t.section('§4 — REAL RENDER: depth in truecolor, the same fill at 16 colours')
  {
    const capture = (theme: string, label: string): string[] => {
      const out = join(scratch, `${label}.json`)
      const cfg = join(scratch, `${label}-cfg.json`)
      writeFileSync(
        cfg,
        JSON.stringify({
          argv: [process.execPath, 'run', SELF],
          sends: [],
          total: 150,
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
          ...(label === 'ansi' ? { MERCURY_TRUECOLOR: '0', FORCE_COLOR: '1' } : {}),
        },
      })
      if (r.status !== 0) return []
      try {
        const payload = JSON.parse(readFileSync(out, 'utf8')) as {
          grid: { c: string; fg: string }[][]
        }
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
    checkWithFix('the gauge rendered (full + partial bars)', tcFull.length >= 8 && tcPartial.length >= 2, `${tcFull.length}/${tcPartial.length} filled cells`, 'zero cells means the vshot capture failed (scripts/ui/vshot.py) or the child render crashed; run this file with SPECTRAL_RENDER_CHILD=1 to see ProgressBar in src/screen/widgets/components.tsx render')
    checkWithFix(
      'and paints DEPTH — several distinct stops across the track',
      new Set(tcFull).size >= 3,
      `${new Set(tcFull).size} distinct inks: ${[...new Set(tcFull)].join(' ')}`,
      'ProgressBar in src/screen/widgets/components.tsx must colour filled cells from the spectralRampFor ramp',
    )

    const ansi = capture('dark', 'ansi')
    const anFull = ansi[0] ?? []
    const anPartial = ansi[1] ?? []
    checkWithFix('the 16-colour gauge rendered (both bars)', anFull.length >= 8 && anPartial.length >= 2, `${anFull.length}/${anPartial.length} filled cells`, 'zero cells means the vshot capture failed (scripts/ui/vshot.py) or the child render crashed under MERCURY_TRUECOLOR=0')
    checkWithFix(
      'the FULL fill length is identical either way',
      tcFull.length === anFull.length,
      `${tcFull.length} vs ${anFull.length}`,
      'ProgressBar in src/screen/widgets/components.tsx must fill the same cell count whatever the colour depth',
    )
    checkWithFix(
      'the PARTIAL fill length is identical either way — colour never carries the state where it could',
      tcPartial.length === anPartial.length,
      `${tcPartial.length} vs ${anPartial.length}`,
      'ProgressBar in src/screen/widgets/components.tsx must fill the same cell count whatever the colour depth',
    )
  }

  rmSync(scratch, { recursive: true, force: true })
  t.finish('prove-spectral-depth')
}
