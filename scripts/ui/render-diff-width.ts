#!/usr/bin/env bun
import { vshotBudgetMs } from '../lib/captureDriver.ts'
// ============================================================================
//  scripts/ui/render-diff-width.tsx — RENDER-VERIFY for (opt-in under
//  UI_RENDER=1). Self-spawning Ink harness that mounts the REAL PermissionDialog
//  (innerPaddingX={0}, the FilePermissionDialog composition) wrapping the REAL
//  FileWriteToolDiff / FileEditToolDiff, so the actual fork left-chrome (rail +
//  paddingLeft = 2 cols) is in the live tree.
//
//  The bug is the WIDTH VALUE each diff passes to ColorDiff.render —
//  in fork mode it was 2 cols too wide (it ignored PermissionDialog's left
//  chrome), so the body bled past the rail. color-diff-napi is bun-unloadable,
//  so we stub it with a render() that ECHOES its width argument (each line is
//  exactly `width` cells of a marker). Measuring the marker run in the captured
//  grid is then a direct, faithful test of the width the REAL component chain
//  (FileWriteToolDiff/FileEditToolDiff → StructuredDiff → ColorDiff.render(W))
//  computed — and whether it fits flush inside the real PermissionDialog chrome.
//
//  Run:  ~/.bun/bin/bun run scripts/ui/render-diff-width.tsx
//  (The stamp is the production version.)
// ============================================================================
const MARKER = '#'
// ── child: stub color-diff-napi (width-echo) + render in the real chrome ────
if (process.env.DIFF_WIDTH_CHILD) {
  ;(globalThis as Record<string, unknown>).MACRO = {
    VERSION: '1.0.0',
    ISSUES_EXPLAINER: '', PACKAGE_URL: '', README_URL: '', IS_DEV: false, IS_DEMO: false,
  }
  // Echo-the-width stub: render(theme,width,dim) → 3 lines each `width` cells.
  // Plus source-stubs for the two bun-unloadable leaves that are OFF the render
  // path here (useSettings only yields a boolean we default; HighlightedCode is
  // only mounted in FileWrite's !fileExists branch — we pass fileExists=true).
  // Both pull the feature() macro / settings SCC that only build.ts resolves.
  Bun.plugin({
    name: 'stub-color-diff-napi-echo',
    setup(build) {
      build.module('color-diff-napi', () => ({
        loader: 'object',
        exports: {
          ColorDiff: class {
            render(_theme: string, width: number, _dim: boolean): string[] {
              // Record the EXACT width the real component chain (FileWrite/
              // FileEditToolDiff → StructuredDiff → ColorDiff.render) passed to
              // the renderer — that IS the bug locus the fix changes. (Visual
              // overflow alone is unreliable: Ink silently clips an over-wide
              // RawAnsi in a no-padding frame, masking the FileEdit case.)
              const out = process.env.DIFF_WIDTH_OUT
              if (out) { try { require('node:fs').appendFileSync(out, width + '\n') } catch {} }
              const line = MARKER.repeat(Math.max(1, width))
              return [line, line, line]
            }
          },
          ColorFile: class {},
          getSyntaxTheme: () => ({}),
        },
      }))
      build.onLoad({ filter: /hooks\/useSettings\.(ts|js)$/ }, () => ({
        contents: 'export function useSettings(){ return {} }', loader: 'js',
      }))
      build.onLoad({ filter: /components\/HighlightedCode\.(tsx|js)$/ }, () => ({
        contents: 'export function HighlightedCode(){ return null }', loader: 'js',
      }))
    },
  })

  const React = await import('react')
  const { render, Box, Text } = (await import('../../src/ink.js')) as {
    render: (n: React.ReactNode) => Promise<unknown>
    Box: React.ComponentType<Record<string, unknown>>
    Text: React.ComponentType<Record<string, unknown>>
  }
  const { PermissionDialog } = await import('../../src/components/permissions/PermissionDialog.js')
  const { FileWriteToolDiff } = await import(
    '../../src/components/permissions/FileWritePermissionRequest/FileWriteToolDiff.js'
  )
  const { FileEditToolDiff } = await import('../../src/components/FileEditToolDiff.js')

  const target = '/tmp/hb0200-edit-target.txt'
  const oldContent = 'alpha\nbeta\ngamma\ndelta'
  const newContent = 'alpha\nbeta CHANGED\ngamma\ndelta\nepsilon'

  const which = process.env.DIFF_WIDTH_WHICH ?? 'write'
  const content =
    which === 'write'
      ? React.createElement(FileWriteToolDiff, {
          file_path: '/tmp/hb0200-test.txt', content: newContent, fileExists: true, oldContent,
        })
      : React.createElement(FileEditToolDiff, {
          file_path: target,
          edits: [{ old_string: 'beta', new_string: 'beta CHANGED', replace_all: false }],
        })

  const el = React.createElement(
    PermissionDialog,
    { title: `${which === 'write' ? 'Write' : 'Edit'} file`, innerPaddingX: 0 },
    content,
  )
  const { Suspense } = React
  await render(React.createElement(Suspense, { fallback: React.createElement(Text, null, '…') }, el))
  await new Promise(r => setTimeout(r, 900))
  process.exit(0)
}

// ── parent: drive vshot captures + measure the marker run ───────────────────
import { execFileSync } from 'node:child_process'
import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveProofHome } from '../lib/proofHome.ts'

const SELF = fileURLToPath(import.meta.url)
const VSHOT = new URL('./vshot.py', import.meta.url).pathname
// The proof's config home (scripts/lib/proofHome.ts): the inherited pin, else
// a fresh seeded scratch — never another program's directory.
const CONFIG_HOME = resolveProofHome([process.cwd()])
if (!existsSync(VSHOT)) {
  console.error('vshot.py missing — the render-verify harness (scripts/ui/vshot.py) is required')
  process.exit(1)
}
writeFileSync('/tmp/hb0200-edit-target.txt', 'alpha\nbeta\ngamma\ndelta\n')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

// expected body width (the Mercury chrome — the only regime since the
// the version seam is deleted):
//   FileWrite: columns - 4          [perm chrome(2) + own paddingX(2)]
//   FileEdit:  columns - 2 - (railed?2:0)   [railed = cols > 80]
const expectWidth = (which: string, cols: number): number => {
  if (which === 'write') return Math.max(1, cols - 4)
  const railed = cols > 80
  return Math.max(1, cols - 2 - (railed ? 2 : 0))
}

// All marker-row run lengths. A correct (fitted) render emits every body line at
// exactly `want` cells; a too-wide width OVERFLOWS → Yoga wraps it into a full row
// (cols-startCol markers) + a short remainder row (< want) → the min run drops
// below want. So {min == max == want} is a regime-independent overflow detector.
const markerRuns = (grid: string): number[] => {
  const runs: number[] = []
  for (const line of grid.split('\n'))
    for (const run of line.match(new RegExp(`${MARKER}+`, 'g')) ?? []) runs.push(run.length)
  return runs
}

console.log('============================================================')
console.log(' HB-0200 render-verify: permission diff width in the Mercury chrome')
console.log('============================================================')

const capture = (which: string, cols: number, rows: number): { grid: string; widthOut: string } => {
  const tag = `${which}-${cols}`
  const widthOut = `/tmp/hb0200-width-${tag}.txt`
  try { require('node:fs').rmSync(widthOut) } catch {}
  const cfg = `/tmp/vs-diffwidth-${tag}.json`
  writeFileSync(cfg, JSON.stringify({
    argv: [process.execPath, SELF],
    sends: [], total: 15, cols, rows,
    out: `/tmp/diffwidth-${tag}.json`,
  }))
  // vshot.py never reads cfg.env — the child-branch marker MUST ride the spawn
  // env, or the PTY child re-enters this parent branch and forks vshot
  // recursively — that exact fork-bomb class can take a machine to load
  // 113. vshot refuses to nest, and
  // no pkill of dist/mercury.mjs sits here — a blanket pkill kills
  // the operator's LIVE sessions whenever the proof runs.
  const grid = execFileSync('/usr/bin/python3', [VSHOT, cfg], {
    encoding: 'utf-8',
    timeout: vshotBudgetMs(30000),
    env: {
      ...process.env,
    // Split-home guard: bun-side writers and the stamp-defaulted dist must
    // resolve ONE home even outside the gate unit's pin (pinned home).
    MERCURY_CONFIG_DIR: CONFIG_HOME,
      DIFF_WIDTH_CHILD: '1', DIFF_WIDTH_WHICH: which,
      DIFF_WIDTH_OUT: widthOut, NODE_ENV: 'test',    },
  })
  return { grid, widthOut }
}

for (const which of ['write', 'edit']) {
  {
    for (const [cols, rows] of [[80, 24], [120, 30]] as const) {
      const tag = `${which}@${cols}`
      try {
        const { grid, widthOut } = capture(which, cols, rows)
        const want = expectWidth(which, cols)
        // (1) PRIMARY (faithful, robust): the EXACT width the real component chain
        //     computed and passed to ColorDiff.render, observed at the leaf.
        const recorded = (() => {
          try { return readFileSync(widthOut, 'utf-8').trim().split('\n').map(Number) } catch { return [] }
        })()
        const allMatch = recorded.length > 0 && recorded.every(w => w === want)
        check(`${tag}: ColorDiff.render width == ${want} (real chain, all hunks)`, allMatch,
          recorded.length ? `recorded ${[...new Set(recorded)].join(',')}` : 'none recorded')
        // (2) the diff actually rendered (the marker is present in the live tree)
        const runs = markerRuns(grid)
        check(`${tag}: diff body rendered in the dialog`, runs.length > 0, `${runs.length} marker rows`)
        // (3) the Mercury dialog rail │ sits at column 0
        const lines = grid.split('\n')
        const railRows = lines.filter(l => l[0] === '│').length
        check(`${tag}: dialog rail │ at column 0`, railRows > 0, `${railRows} rows`)
      } catch (e: unknown) {
        check(`${tag}: capture succeeded`, false, String(e).slice(0, 120))
      }
    }
  }
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ HB-0200 render-verify — diff width fits the Mercury chrome')
  process.exit(0)
} else {
  console.log(` ❌ HB-0200 render-verify — ${failures} check(s) failed`)
  process.exit(1)
}
