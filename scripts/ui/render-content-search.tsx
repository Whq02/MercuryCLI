#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/render-content-search.tsx — DETERMINISTIC render-verify for the
//  warm-ink CONTENT search (MercuryContentSearch, ctrl+x g). Joins the ui suite
//  under UI_RENDER=1. Mounts the component DIRECTLY with a MOCK loadMatches (fixed
//  grep hits) + types a query via vshot — no chord, no real ripgrep — and asserts
//  the rows + the matched-substring bold from the cell-grid JSON (cell.bold).
//
//  Run:  UI_RENDER=1 ~/.bun/bin/bun run scripts/ui/render-content-search.tsx
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
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveProofHome } from '../lib/proofHome.ts'

const SELF = fileURLToPath(import.meta.url)
const VSHOT = join(dirname(SELF), 'vshot.py') // the in-repo capturer (was the ephemeral /tmp copy)
// The proof's config home (scripts/lib/proofHome.ts): the inherited pin, else
// a fresh seeded scratch — never another program's directory.
const CONFIG_HOME = resolveProofHome([process.cwd()])

if (process.env.SEARCH_RENDER_CHILD) {
  const React = await import('react')
  const { render } = (await import('../../src/ink.js')) as {
    render: (n: React.ReactNode) => Promise<unknown>
  }
  const { MercuryContentSearch } = await import('../../src/components/MercuryContentSearch.js')
  const h = React.createElement
  // Mock grep: returns fixed hits whose text contains the query "mercury".
  const mock = [
    { file: 'src/components/MercuryFrame.tsx', line: 60, text: '  // Mercury statusbar' },
    { file: 'CLAUDE.md', line: 3, text: 'This is Mercury — a standalone agent' },
    { file: 'src/query.ts', line: 12, text: 'const mercury = true' },
  ]
  const loadMatches = async () => mock
  void render(h(MercuryContentSearch, { onPick: () => {}, onClose: () => {}, loadMatches }))
  // Long enough that the parent's typed query (sent ~tick 10 ≈ 2s) paints and
  // settles well before exit — the old 2.5s window raced the send.
  setTimeout(() => process.exit(0), 4500)
} else {
  let failures = 0
  const check = (label: string, cond: boolean, detail = ''): void => {
    if (!cond) failures++
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
  }
  if (!existsSync(VSHOT)) {
    console.error(`vshot.py not found at ${VSHOT}.`)
    process.exit(1)
  }
  const EMOJI = /[\u{1F000}-\u{1FAFF}\u{FE0F}]/u

  type Cell = { c: string; bold: boolean }
  const capture = (cols: number): { grid: string; cells: Cell[] } => {
    const cfg = `/tmp/vs-cs-${cols}.json`
    const out = `/tmp/cs-${cols}.json`
    writeFileSync(
      cfg,
      JSON.stringify({
        argv: [process.execPath, 'run', SELF],
        // vshot sends are [{atTick, data}] in 0.2s ticks — type the query at
        // ~2s (past bun startup + mount + the 150ms mount-buffer).
        sends: [{ atTick: 10, data: 'mercury' }],
        total: 22,
        cols,
        rows: 22,
        out,
      }),
    )
    // vshot.py never reads cfg.env — the child-branch marker rides execFileSync's env.
    const grid = execFileSync('/usr/bin/python3', [VSHOT, cfg], {
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env,
    // Split-home guard: bun-side writers and the stamp-defaulted dist must
    // resolve ONE home even outside the gate unit's pin (pinned home).
    MERCURY_CONFIG_DIR: CONFIG_HOME, SEARCH_RENDER_CHILD: '1' },
    })
    const cells: Cell[] = existsSync(out)
      ? (JSON.parse(readFileSync(out, 'utf-8')) as { grid: Cell[][] }).grid.flat()
      : []
    return { grid, cells }
  }

  console.log('============================================================')
  console.log(' content search (MercuryContentSearch) render-verify')
  console.log('============================================================')

  for (const cols of [110, 80]) {
    console.log(`\n  ── content-search @ ${cols} (query "mercury") ──`)
    const { grid, cells } = capture(cols)
    const bold = (c: string) => cells.some(cell => cell.c === c && cell.bold)
    check(`@${cols}: the "search" command-center header renders`, /search/.test(grid))
    check(`@${cols}: file:line locations render`, /MercuryFrame\.tsx:60|CLAUDE\.md:3|query\.ts:12/.test(grid))
    check(`@${cols}: the honest footer advertises "insert @file#L"`, /insert @file#L/.test(grid))
    check(`@${cols}: matched substring "Mercury"/"mercury" is BOLD (cell.bold)`, bold('M') || bold('m') || bold('e'))
    check(`@${cols}: NO emoji in the grid`, !EMOJI.test(grid))
  }

  console.log('\n' + '='.repeat(60))
  if (failures === 0) {
    console.log(' ✅ content search — grep rows + matched-substring highlight @110 + @80')
    process.exit(0)
  } else {
    console.log(` ❌ content search — ${failures} check(s) failed`)
    process.exit(1)
  }
}
