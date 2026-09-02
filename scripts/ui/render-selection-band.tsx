#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/render-selection-band.tsx — DETERMINISTIC render-verify for the
//  LUSTRE L2 selection band at its OWNER (joins the ui suite under
//  UI_RENDER=1). Mounts InteractiveRow directly (no chord, no typed input):
//
//    · the selected CURSOR row paints tokens.selectionBand across the row's
//      full width (not a text-hug fill);
//    · the unselected sibling paints NO background;
//    · a directActivate control and a function-children row stay band-free
//      even while selected (persistent state ≠ the Enter target).
//
//  Run:  UI_RENDER=1 ~/.bun/bin/bun run scripts/ui/render-selection-band.tsx
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

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const VSHOT = join(dirname(SELF), 'vshot.py')

if (process.env.BAND_RENDER_CHILD) {
  // ── child: mount InteractiveRow rows directly ─────────────────────────────
  const React = await import('react')
  const ink = (await import('../../src/ink.js')) as {
    render: (n: React.ReactNode) => Promise<unknown>
    Box: React.ComponentType<Record<string, unknown>>
    Text: React.ComponentType<Record<string, unknown>>
  }
  const { InteractiveRow } = await import('../../src/components/mercury-ui/InteractiveRow.js')
  const h = React.createElement
  const noop = (): void => {}
  void ink.render(
    h(
      ink.Box,
      { flexDirection: 'column', width: 60 },
      h(
        InteractiveRow as never,
        { id: 'band:row:sel', selected: true, width: '100%', onSelect: noop, onActivate: noop },
        h(ink.Text, null, 'SELECTED cursor row'),
      ),
      h(
        InteractiveRow as never,
        { id: 'band:row:un', selected: false, width: '100%', onSelect: noop, onActivate: noop },
        h(ink.Text, null, 'unselected row'),
      ),
      h(
        InteractiveRow as never,
        { id: 'band:row:direct', selected: true, width: '100%', directActivate: true, onActivate: noop },
        h(ink.Text, null, 'directActivate control'),
      ),
      h(
        InteractiveRow as never,
        { id: 'band:row:fn', selected: true, width: '100%', onSelect: noop, onActivate: noop },
        ((hover: boolean) => h(ink.Text, null, `function child ${hover ? 'h' : ' '}`)) as never,
      ),
    ),
  )
  await new Promise(r => setTimeout(r, 4000))
  process.exit(0)
}

// vshot.py never reads cfg.env — the PTY child inherits THIS process env, so
// the child-branch marker rides execFileSync's env option (vshot's own rule).
const cfg = {
  argv: [process.execPath.includes('bun') ? process.execPath : 'bun', 'run', SELF],
  cols: 60,
  rows: 8,
  total: 14,
  sends: [],
  out: '/tmp/band-grid.json',
}
writeFileSync('/tmp/band-cfg.json', JSON.stringify(cfg))
execFileSync('/usr/bin/python3', [VSHOT, '/tmp/band-cfg.json'], {
  stdio: 'pipe',
  env: { ...process.env, BAND_RENDER_CHILD: '1' },
})
const grid = JSON.parse(readFileSync('/tmp/band-grid.json', 'utf8')).grid as Array<
  Array<{ c: string; fg: string; bg: string }>
>

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const rowOf = (needle: string) => grid.find(r => r.map(c => c.c).join('').includes(needle))
const bgs = (r: Array<{ c: string; bg: string }> | undefined) =>
  r ? new Set(r.filter(c => c.bg !== 'default').map(c => c.bg)) : new Set<string>()

const sel = rowOf('SELECTED cursor row')
const un = rowOf('unselected row')
const direct = rowOf('directActivate control')
const fn = rowOf('function child')

check('all four rows rendered', !!sel && !!un && !!direct && !!fn)
const selBgs = bgs(sel)
check('selected cursor row paints ONE band bg', selBgs.size === 1, [...selBgs].join(','))
if (sel && selBgs.size === 1) {
  const band = [...selBgs][0]!
  const banded = sel.filter(c => c.bg === band).length
  check('the band claims the row WIDTH (≥58 of 60 cells)', banded >= 58, `${banded} cells`)
}
check('unselected row paints NO bg', bgs(un).size === 0, [...bgs(un)].join(','))
check('directActivate control paints NO band', bgs(direct).size === 0, [...bgs(direct)].join(','))
check('function-children row paints NO band', bgs(fn).size === 0, [...bgs(fn)].join(','))

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
