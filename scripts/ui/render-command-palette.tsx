#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '1.0.0',
  ISSUES_EXPLAINER: '',
  PACKAGE_URL: '',
  README_URL: '',
  IS_DEV: false,
  IS_DEMO: false,
}

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveProofHome } from '../lib/proofHome.ts'

const SELF = fileURLToPath(import.meta.url)
const VSHOT = join(dirname(SELF), 'vshot.py')
const CONFIG_HOME = resolveProofHome([process.cwd()])

if (process.env.PALETTE_RENDER_CHILD) {
  const React = await import('react')
  const ink = (await import('../../src/ink.js')) as {
    render: (n: React.ReactNode) => Promise<unknown>
    Box: React.ComponentType<Record<string, unknown>>
  }
  const { NameHighlight } = await import('../../src/components/MercuryCommandPalette.js')
  const { TERRA, IVORY, SECOND } = await import('../../src/components/mercuryPalette.js')
  const h = React.createElement
  const row = (name: string, query: string, here: boolean) =>
    h(NameHighlight, {
      name,
      query,
      here,
      accent: TERRA,
      textPrimary: IVORY,
      textSecondary: SECOND,
      key: `${name}-${query}`,
    })
  void ink.render(
    h(
      ink.Box,
      { flexDirection: 'column' },
      row('color', 'co', true),
      row('cockpit', 'ckpt', false),
      row('compact', '', false),
    ),
  )
  setTimeout(() => process.exit(0), 1800)
} else {
  let failures = 0
  const check = (label: string, cond: boolean, detail = ''): void => {
    if (!cond) failures++
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
  }
  if (!existsSync(VSHOT)) {
    console.error(`vshot.py not found at ${VSHOT} — the render-verify harness (scripts/ui/vshot.py) is required.`)
    process.exit(1)
  }
  const EMOJI = /[\u{1F000}-\u{1FAFF}\u{FE0F}]/u
  const cfg = '/tmp/vs-pal-hl.json'
  const out = '/tmp/pal-hl.json'
  writeFileSync(
    cfg,
    JSON.stringify({
      argv: [process.execPath, 'run', SELF],
      sends: [],
      total: 20,
      cols: 40,
      rows: 6,
      out,
    }),
  )
  const grid = execFileSync('/usr/bin/python3', [VSHOT, cfg], {
    encoding: 'utf-8',
    timeout: 30000,
    env: { ...process.env,
    MERCURY_CONFIG_DIR: CONFIG_HOME, PALETTE_RENDER_CHILD: '1' },
  })
  type Cell = { c: string; bold: boolean }
  const cells: Cell[] = existsSync(out)
    ? (JSON.parse(readFileSync(out, 'utf-8')) as { grid: Cell[][] }).grid.flat()
    : []
  const bold = (c: string) => cells.some(cell => cell.c === c && cell.bold)

  console.log('============================================================')
  console.log(' command palette — fuzzy match-highlight (NameHighlight, deterministic)')
  console.log('============================================================\n')

  check('the three names render', /color/.test(grid) && /cockpit/.test(grid) && /compact/.test(grid))
  check('NO emoji in the grid', !EMOJI.test(grid))
  check("matched 'c' is BOLD", bold('c'))
  check("matched 'o' is BOLD (color/co)", bold('o'))
  check("matched 'k' is BOLD (cockpit/ckpt)", bold('k'))
  check("matched 'p' is BOLD (cockpit/ckpt)", bold('p'))
  check("matched 't' is BOLD (cockpit/ckpt)", bold('t'))
  check("non-matched 'l' is NOT bold", !bold('l'))
  check("non-matched 'r' is NOT bold", !bold('r'))

  console.log('\n' + '='.repeat(60))
  if (failures === 0) {
    console.log(' ✅ command palette — highlight bolds EXACTLY the fuzzy-matched chars')
    process.exit(0)
  } else {
    console.log(` ❌ command palette highlight — ${failures} check(s) failed`)
    process.exit(1)
  }
}
