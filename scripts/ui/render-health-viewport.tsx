#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '1.0.0',
  ISSUES_EXPLAINER: '',
  PACKAGE_URL: '',
  README_URL: '',
  IS_DEV: false,
  MERCURY_DEMO: false,
}

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const VSHOT = join(dirname(SELF), 'vshot.py')

if (process.env.HEALTH_RENDER_CHILD) {
  const React = await import('react')
  const { render } = (await import('../../src/ink.js')) as {
    render: (n: React.ReactNode) => Promise<unknown>
  }
  const { AppStateProvider } = await import('../../src/state/AppState.js')
  const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.js')
  const { MercuryHealthCertificate } = await import('../../src/commands/health/HealthCertificate.js')
  const h = React.createElement
  void render(
    h(
      AppStateProvider as never,
      { onChangeAppState: () => {} } as never,
      h(KeybindingSetup as never, {} as never, h(MercuryHealthCertificate as never, { onClose: () => {} } as never)),
    ),
  )
  setTimeout(() => process.exit(0), 20000)
} else {
  let failures = 0
  const check = (label: string, cond: boolean, detail = ''): void => {
    if (!cond) failures++
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  }
  if (!existsSync(VSHOT)) {
    console.error('vshot.py missing — render-verify required')
    process.exit(1)
  }

  const TOTAL = 18
  const capture = (cols: number, rows: number, sends: { atTick: number; data: string }[]): string => {
    const home = mkdtempSync(join(tmpdir(), 'health-vp-'))
    const cfg = `/tmp/vs-health-vp-${cols}x${rows}.json`
    writeFileSync(
      cfg,
      JSON.stringify({
        argv: [process.execPath, 'run', SELF],
        sends,
        total: TOTAL,
        cols,
        rows,
        out: `/tmp/health-vp-${cols}x${rows}.json`,
      }),
    )
    try {
      return execFileSync('/usr/bin/python3', [VSHOT, cfg], {
        encoding: 'utf-8',
        timeout: 120000,
        env: {
          ...process.env,
          MERCURY_CONFIG_DIR: home,
          HEALTH_RENDER_CHILD: '1',
          MERCURY_LIVE_GLYPHS: '0',
          MERCURY_CRITTER_GAZE: '0',
        },
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  console.log('============================================================')
  console.log(' /health viewport render-verify (short-terminal contract)')
  console.log('============================================================')

  {
    const grid = capture(100, 24, [])
    const lines = grid.split('\n')
    check('@100x24: the verdict banner is on-screen', /CERTIFIED|CAUTION|FAULT|examining/.test(grid))
    check('@100x24: the keybind footer is on-screen', grid.includes('esc close') && grid.includes('re-run'))
    check('@100x24: the position marker rides the footer tail (packFooter slots the close hint LAST)', /\d+\/\d+ · esc close/.test(grid))
    check('@100x24: page verbs are visible', grid.includes('⇞⇟ page'))
    const bottomBorder = lines.findIndex(l => l.includes('╰'))
    check('@100x24: the frame bottom border is INSIDE the grid', bottomBorder !== -1, 'no ╰ row found — frame overflowed')
    check('@100x24: no emoji', !/[\u{1F300}-\u{1FAFF}]/u.test(grid))
  }

  {
    const sends = [
      { atTick: 14, data: '\x1b[6~' },
      { atTick: 15, data: '\x1b[B' },
      { atTick: 16, data: '\x1b[B' },
    ]
    const grid = capture(100, 24, sends)
    check('@100x24 after ⇟↓↓: the ▸ cursor row is on-screen', grid.includes('▸'))
    check('@100x24 after ⇟↓↓: the footer survived the scroll', grid.includes('esc close'))
    const m = grid.match(/(\d+)\/(\d+) · esc close/)
    check('@100x24 after ⇟↓↓: the position advanced past a page', !!m && Number(m[1]) > 10, m ? `at ${m[1]}/${m[2]}` : 'no marker')
  }

  {
    const grid = capture(120, 50, [])
    check('@120x50: two-column certificate renders', grid.includes('esc close'))
    check('@120x50: the provenance legend is fixed chrome (≥30 rows)', grid.includes('every claim names its evidence'))
  }

  console.log(failures === 0 ? '\nHEALTH VIEWPORT: ALL GREEN' : `\nHEALTH VIEWPORT: ${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}
