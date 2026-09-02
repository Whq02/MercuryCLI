#!/usr/bin/env bun
// ============================================================================
//  scripts/primitives-kernel/render-primitives-kernel-cards.tsx — the rendered primitive state
//  MATRIX. Mounts every execution state, every transaction
//  state, and the honesty degradations through the PRODUCTION mappings
//  (executionCardState / transactionCardState → cardTone) and captures the
//  REAL PTY grid at 120 + 80 cols:
//    · every primitive state renders its grammar glyph (never the unknown
//      fallback '·');
//    · settled-good reads ✓, settled-bad ×, motion ◐, attention ▲,
//      indeterminate ?;
//    · applied-awaiting-check reads IN-MOTION-class, never settled-good;
//    · no emoji anywhere.
//
//  Run:  UI_RENDER=1 ~/.bun/bin/bun run scripts/primitives-kernel/render-primitives-kernel-cards.tsx
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
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveProofHome } from '../lib/proofHome.ts'

const SELF = fileURLToPath(import.meta.url)
const VSHOT = join(dirname(SELF), '..', 'ui', 'vshot.py')
// The proof's config home (scripts/lib/proofHome.ts): the inherited pin, else
// a fresh seeded scratch — never another program's directory.
const CONFIG_HOME = resolveProofHome([process.cwd()])

if (process.env.AXIOM_CARDS_CHILD) {
  // ── child: mount the matrices through the production mappings ─────────────
  const React = await import('react')
  const { render, Box, Text } = (await import('../../src/ink.js')) as {
    render: (n: React.ReactNode) => Promise<unknown>
    Box: never
    Text: never
  }
  const { cardTone } = await import('../../src/components/mercury-ui/toolCardGrammar.js')
  const {
    EXECUTION_STATES,
    TRANSACTION_STATES,
    executionCardState,
    transactionCardState,
  } = await import('../../src/services/primitives/index.js')
  const h = React.createElement

  const row = (label: string, cardState: string) => {
    const tone = cardTone(cardState)
    return h(
      Text as never,
      { key: label } as never,
      h(Text as never, { color: tone.tone } as never, tone.glyph),
      h(Text as never, {} as never, ` EX${label}XE`),
    )
  }
  const tree = h(
    Box as never,
    { flexDirection: 'column' } as never,
    h(Text as never, {} as never, 'AXIOMEXECMATRIX'),
    ...EXECUTION_STATES.map(s => row(`exec-${s}`, executionCardState(s))),
    h(Text as never, {} as never, 'AXIOMTXNMATRIX'),
    ...TRANSACTION_STATES.map(s => row(`txn-${s}`, transactionCardState(s))),
    h(Text as never, {} as never, 'AXIOMDEGRADATIONS'),
    ...(['absent', 'expired', 'busy', 'unavailable'] as const).map(s => row(`deg-${s}`, s)),
  )
  void render(tree)
  setTimeout(() => process.exit(0), 1500)
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

  const capture = (cols: number): string => {
    const cfg = `/tmp/vs-axiom-cards-${cols}.json`
    writeFileSync(
      cfg,
      JSON.stringify({
        argv: [process.execPath, 'run', SELF],
        sends: [],
        total: 15,
        cols,
        rows: 45,
        out: `/tmp/axiom-cards-${cols}.json`,
      }),
    )
    return execFileSync('/usr/bin/python3', [VSHOT, cfg], {
      encoding: 'utf-8',
      timeout: 30000,
      env: {
        ...process.env,
        MERCURY_CONFIG_DIR: CONFIG_HOME,
        AXIOM_CARDS_CHILD: '1',
      },
    })
  }

  console.log('============================================================')
  console.log(' axiom primitive state matrix render-verify')
  console.log('============================================================')

  // The spine's marks (prove-status-spine-unity, R3): settled-good ● ·
  // failure ✕ · motion ◐ · stopped the neutral ○ (never a tick) ·
  // cancelled/busy the attention hold ⦿ · expiry the spine's staleness ↻ ·
  // unavailable — (muted).
  const GLYPH_FOR: Record<string, string> = {
    // execution
    'exec-queued': '◐', 'exec-starting': '◐', 'exec-ready': '●', 'exec-running': '◐',
    'exec-waiting': '◐', 'exec-stopping': '◐', 'exec-stopped': '○', 'exec-succeeded': '●',
    'exec-failed': '✕', 'exec-cancelled': '⦿', 'exec-unavailable': '—', 'exec-indeterminate': '?',
    // transaction (through transactionCardState)
    'txn-created': '◐', 'txn-prepared': '◐', 'txn-proposed': '◐', 'txn-authorised': '◐',
    'txn-applying': '◐', 'txn-applied': '◐', 'txn-checking': '◐', 'txn-verified': '●',
    'txn-settled': '●', 'txn-failed': '✕', 'txn-cancelled': '⦿', 'txn-stale': '↻',
    // degradations
    'deg-absent': '✕', 'deg-expired': '↻', 'deg-busy': '⦿', 'deg-unavailable': '—',
  }

  for (const cols of [120, 80]) {
    console.log(`\n  ── matrix @ ${cols} ──`)
    const grid = capture(cols)
    check(`@${cols}: both matrices mounted`, grid.includes('AXIOMEXECMATRIX') && grid.includes('AXIOMTXNMATRIX'))
    let unmapped = 0
    let wrongGlyph = 0
    for (const [label, glyph] of Object.entries(GLYPH_FOR)) {
      const m = grid.match(new RegExp(`(.) EX${label}XE`))
      if (!m) {
        unmapped++
        continue
      }
      if (m[1] !== glyph) wrongGlyph++
    }
    check(`@${cols}: every primitive state row rendered`, unmapped === 0, `${unmapped} missing`)
    check(`@${cols}: every state renders its grammar glyph (no fallback ·)`,
      wrongGlyph === 0 && !/· EX/.test(grid), `${wrongGlyph} wrong`)
    check(`@${cols}: applied reads in-motion-class, never settled-good`,
      /◐ EXtxn-appliedXE/.test(grid))
    check(`@${cols}: NO emoji in the grid`, !EMOJI.test(grid))
  }

  console.log('\n' + '='.repeat(60))
  if (failures === 0) {
    console.log(' ✅ axiom matrix — every primitive state on the ONE grammar @120 + @80')
    process.exit(0)
  } else {
    console.log(` ❌ axiom matrix — ${failures} check(s) failed`)
    process.exit(1)
  }
}
