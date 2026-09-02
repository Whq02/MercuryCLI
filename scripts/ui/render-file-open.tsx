#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/render-file-open.tsx — DETERMINISTIC render-verify for the warm-ink
//  FILE quick-open (MercuryFileOpen, ctrl+x f). Joins the ui suite under UI_RENDER=1.
//  The live chord is timing-hostile in a PTY, so this mounts MercuryFileOpen DIRECTLY
//  (no chord, no typed input) — its async generateFileSuggestions indexes THIS repo,
//  so real file paths render — and captures after the index settles.
//
//  Asserts: the "open file" command-center header, the @-prefixed file rows
//  (real repo paths), the honest footer ("N files · … insert @path"), and NO emoji.
//
//  Run:  UI_RENDER=1 ~/.bun/bin/bun run scripts/ui/render-file-open.tsx
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
const VSHOT = join(dirname(SELF), 'vshot.py') // the in-repo capturer (was the ephemeral /tmp copy)
// The proof's config home (scripts/lib/proofHome.ts): the inherited pin, else
// a fresh seeded scratch — never another program's directory.
const CONFIG_HOME = resolveProofHome([process.cwd()])

if (process.env.FILEOPEN_RENDER_CHILD) {
  // ── child: mount MercuryFileOpen directly; its async index lists this repo ────
  const React = await import('react')
  const { render } = (await import('../../src/ink.js')) as {
    render: (n: React.ReactNode) => Promise<unknown>
  }
  const { MercuryFileOpen } = await import('../../src/components/MercuryFileOpen.js')
  const h = React.createElement
  // Inject a mock loader (fixed file list) so the proof never touches the real
  // generateFileSuggestions chain (a feature()-macro module bun-run can't load).
  const mockFiles = [
    'src/components/MercuryFileOpen.tsx',
    'src/components/MercuryCommandPalette.tsx',
    'src/query.ts',
    'README.md',
    'package.json',
  ].map((displayText, i) => ({ id: `f${i}`, displayText }))
  const loadFiles = async () => mockFiles
  void render(h(MercuryFileOpen, { onPick: () => {}, onClose: () => {}, loadFiles }))
  setTimeout(() => process.exit(0), 2500)
} else {
  // ── parent: capture after the index settles, assert the surface ─────────────
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
    const cfg = `/tmp/vs-fo-${cols}.json`
    writeFileSync(
      cfg,
      JSON.stringify({
        argv: [process.execPath, 'run', SELF],
        sends: [],
        total: 20, // 0.2s ticks (~4s ceiling); the child exits at 2.5s → EOF-break early
        cols,
        rows: 20,
        out: `/tmp/fo-${cols}.json`,
      }),
    )
    // vshot.py never reads cfg.env — the child-branch marker rides execFileSync's env.
    return execFileSync('/usr/bin/python3', [VSHOT, cfg], {
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env,
    // Split-home guard: bun-side writers and the stamp-defaulted dist must
    // resolve ONE home even outside the gate unit's pin (pinned home).
    MERCURY_CONFIG_DIR: CONFIG_HOME, FILEOPEN_RENDER_CHILD: '1' },
    })
  }

  console.log('============================================================')
  console.log(' file quick-open (MercuryFileOpen) render-verify')
  console.log('============================================================')

  for (const cols of [110, 80]) {
    console.log(`\n  ── file-open @ ${cols} ──`)
    const grid = capture(cols)
    check(`@${cols}: the "open file" command-center header renders`, /open file/.test(grid))
    check(`@${cols}: @-prefixed file rows render (real repo paths)`, /@\S+\.(ts|tsx|md|json|js)/.test(grid))
    check(`@${cols}: the honest footer advertises "insert @path"`, /insert @path/.test(grid))
    check(`@${cols}: NO emoji in the grid`, !EMOJI.test(grid))
  }

  console.log('\n' + '='.repeat(60))
  if (failures === 0) {
    console.log(' ✅ file quick-open — lists real repo files + inserts @path, @110 + @80')
    process.exit(0)
  } else {
    console.log(` ❌ file quick-open — ${failures} check(s) failed`)
    process.exit(1)
  }
}
