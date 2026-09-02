#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/render-command-palette.tsx — DETERMINISTIC render-verify for the
//  Hermes Command Palette's fuzzy MATCH-HIGHLIGHTING (joins the ui suite under
//  UI_RENDER=1). Mounts the PURE NameHighlight component DIRECTLY with fixed
//  (name, query) props — no chord, no typed input, no timing to race — so the
//  per-char bold is captured deterministically.
//
//  The check: a BOLD cell carries a char ONLY when that char is a fuzzy-matched
//  position. "cockpit" / "ckpt" must bold c,k,p,t; "color" / "co" must bold c,o
//  but NOT l,r (non-matched). pyte plaintext strips style, so the bold
//  assertion reads the cell-grid JSON vshot writes (cell.bold).
//
//  Run:  UI_RENDER=1 ~/.bun/bin/bun run scripts/ui/render-command-palette.tsx
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

if (process.env.PALETTE_RENDER_CHILD) {
  // ── child: mount NameHighlight rows directly (pure, deterministic) ──────────
  const React = await import('react')
  const ink = (await import('../../src/ink.js')) as {
    render: (n: React.ReactNode) => Promise<unknown>
    Box: React.ComponentType<Record<string, unknown>>
  }
  const { NameHighlight } = await import('../../src/components/MercuryCommandPalette.js')
  const { TERRA, IVORY, SECOND } = await import('../../src/components/mercuryPalette.js')
  const h = React.createElement
  // Fixed ink-role props (NameHighlight stays pure — the live palette feeds it
  // useMercuryTokens roles; this deterministic fixture pins the dark values).
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
      row('color', 'co', true), // matched c,o → bold (accent); l,o(2nd),r not
      row('cockpit', 'ckpt', false), // matched c,k,p,t → bold (IVORY)
      row('compact', '', false), // empty query → nothing bold
    ),
  )
  setTimeout(() => process.exit(0), 1800)
} else {
  // ── parent: capture once (no input), assert bold from the HTML ──────────────
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
      total: 20, // 0.2s ticks (~4s ceiling); the child exits at 1.8s → EOF-break early
      cols: 40,
      rows: 6,
      out,
    }),
  )
  // vshot.py never reads cfg.env — the PTY child inherits THIS process env, so
  // the child-branch marker must ride execFileSync's env option.
  const grid = execFileSync('/usr/bin/python3', [VSHOT, cfg], {
    encoding: 'utf-8',
    timeout: 30000,
    env: { ...process.env,
    // Split-home guard: bun-side writers and the stamp-defaulted dist must
    // resolve ONE home even outside the gate unit's pin (pinned home).
    MERCURY_CONFIG_DIR: CONFIG_HOME, PALETTE_RENDER_CHILD: '1' },
  })
  // Bold is asserted from the cell-grid JSON (out) — pyte cells carry {c, bold}.
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
  // matched chars are BOLD: color/co → c,o ; cockpit/ckpt → c,k,p,t
  check("matched 'c' is BOLD", bold('c'))
  check("matched 'o' is BOLD (color/co)", bold('o'))
  check("matched 'k' is BOLD (cockpit/ckpt)", bold('k'))
  check("matched 'p' is BOLD (cockpit/ckpt)", bold('p'))
  check("matched 't' is BOLD (cockpit/ckpt)", bold('t'))
  // non-matched chars are NOT bold: 'l','r' appear only in "color" and aren't in "co"
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
