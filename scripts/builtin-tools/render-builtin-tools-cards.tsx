#!/usr/bin/env bun
// ============================================================================
//  scripts/builtin-tools/render-builtin-tools-cards.tsx — the capability cards
//  RENDERED. Mounts the PRODUCTION renderers (StructureTool /
//  GitTool / JourneyTool UI) with representative outputs and captures the
//  REAL PTY grid at 120 + 80 cols:
//    · a structural PREVIEW card reads 'proposed' (in-motion ◐) and an
//      APPLIED card reads settled-good ✓ — the two states can NEVER look
//      identical;
//    · a git PLAN card reads 'proposed' ◐, an applied plan ✓;
//    · a journey card's verdict wins over the effect outcome: failed ×,
//      cancelled ⦿, succeeded ● — a failed step can never render as
//      success;
//    · refusals read settled-bad ×; no emoji anywhere; narrow (80) keeps
//      every state word visible.
//
//  Run:  ~/.bun/bin/bun run scripts/builtin-tools/render-builtin-tools-cards.tsx
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

if (process.env.ARSENAL_CARDS_CHILD) {
  // ── child: mount the PRODUCTION renderers ─────────────────────────────────
  const React = await import('react')
  const { render, Box, Text } = (await import('../../src/ink.js')) as {
    render: (n: React.ReactNode) => Promise<unknown>
    Box: never
    Text: never
  }
  const structureUI = await import('../../src/tools/StructureTool/UI.js')
  const gitUI = await import('../../src/tools/GitTool/UI.js')
  const journeyUI = await import('../../src/tools/JourneyTool/UI.js')
  const h = React.createElement
  const opts = { verbose: false } as never

  const cards: React.ReactNode[] = [
    h(Text as never, { key: 'h1' } as never, 'ARSENALCARDS'),
    // structure: preview (proposed) vs apply (applied) vs refusal
    structureUI.renderToolResultMessage(
      { op: 'preview', result: 'sp-abc [proposed] replace-callee — 2 match(es)', outcome: 'succeeded' },
      [],
      opts,
    ),
    structureUI.renderToolResultMessage(
      { op: 'apply', result: 'sp-abc APPLIED — 2 file(s) written, re-read verified', outcome: 'succeeded', changedPaths: ['/tmp/a.ts'] },
      [],
      opts,
    ),
    structureUI.renderToolResultMessage(
      { op: 'apply', result: 'apply refused [stale]: stale preview — re-query', outcome: 'failed' },
      [],
      opts,
    ),
    // git: plan (proposed) vs apply (applied)
    gitUI.renderToolResultMessage(
      { op: 'plan', result: 'gp-def [proposed] — 2 group(s) on digest abcd', outcome: 'succeeded' },
      [],
      opts,
    ),
    gitUI.renderToolResultMessage(
      { op: 'apply', result: 'gp-def APPLIED — 2 commit(s)', outcome: 'succeeded' },
      [],
      opts,
    ),
    // journey: verdict wins over outcome
    journeyUI.renderToolResultMessage(
      { op: 'run', result: 'jy-1 [succeeded] verify the fixture', outcome: 'succeeded', journeyState: 'succeeded' },
      [],
      opts,
    ),
    journeyUI.renderToolResultMessage(
      { op: 'run', result: 'jy-2 [failed] step 2 failed: status 500', outcome: 'failed', journeyState: 'failed' },
      [],
      opts,
    ),
    journeyUI.renderToolResultMessage(
      { op: 'run', result: 'jy-3 [cancelled] cancelled mid-journey', outcome: 'no-change', journeyState: 'cancelled' },
      [],
      opts,
    ),
    h(Text as never, { key: 'h2' } as never, 'ARSENALCARDSEND'),
  ]
  const tree = h(Box as never, { flexDirection: 'column' } as never, ...cards)
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
  const EMOJI = /[\u{1F300}-\u{1FAFF}]/u

  const capture = (cols: number): string => {
    const cfg = `/tmp/vs-arsenal-cards-${cols}.json`
    writeFileSync(
      cfg,
      JSON.stringify({
        argv: [process.execPath, 'run', SELF],
        sends: [],
        total: 15,
        cols,
        rows: 45,
        out: `/tmp/arsenal-cards-${cols}.json`,
      }),
    )
    return execFileSync('/usr/bin/python3', [VSHOT, cfg], {
      encoding: 'utf-8',
      timeout: 30000,
      env: {
        ...process.env,
        MERCURY_CONFIG_DIR: CONFIG_HOME,
        ARSENAL_CARDS_CHILD: '1',
      },
    })
  }

  console.log('============================================================')
  console.log(' arsenal capability cards render-verify')
  console.log('============================================================')

  for (const cols of [120, 80]) {
    console.log(`\n  ── cards @ ${cols} ──`)
    const grid = capture(cols)
    check(`@${cols}: cards mounted`, grid.includes('ARSENALCARDS') && grid.includes('ARSENALCARDSEND'))
    check(
      `@${cols}: structural PREVIEW reads proposed (in-motion), APPLY reads applied (settled-good) — never identical`,
      /◐ structure preview proposed/.test(grid) && /● structure apply applied/.test(grid),
    )
    check(`@${cols}: a refused apply reads settled-bad ✕`, /✕ structure apply failed/.test(grid))
    check(
      `@${cols}: git PLAN proposed ◐ vs applied ● distinct`,
      /◐ git plan proposed/.test(grid) && /● git apply applied/.test(grid),
    )
    check(
      `@${cols}: the journey VERDICT wins — failed ✕, cancelled ⦿, succeeded ●`,
      /✕ journey run failed/.test(grid) && /⦿ journey run cancelled/.test(grid) && /● journey run succeeded/.test(grid),
    )
    check(`@${cols}: no emoji`, !EMOJI.test(grid))
  }

  console.log(failures === 0 ? '\nARSENAL CARDS: ALL GREEN' : `\nARSENAL CARDS: ${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}
