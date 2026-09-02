#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-diff-line-budget.ts — the diff line-budget LAW: a
//  pathological single line (base64 blob, minified bundle) renders as a
//  bounded head plus an honest elision marker naming the cut, and the
//  bounded volume — not the input — is what reaches the highlighter and the
//  wrap pass. StructuredDiff applies the bound ahead of BOTH renderers, so
//  every diff surface (transcript, detail view, permission preview)
//  inherits it.
//
//  Poison: dropping the bound reds the volume ceiling by ~500× on the
//  1MB-line hunk; dropping the marker reds the honesty checks; keying the
//  cache off identity reds the stability checks.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-diff-line-budget.ts
// ============================================================================
import {
  boundPatchForRender,
  DIFF_LINE_MARKER_SLACK,
  DIFF_LINE_RENDER_CAP,
} from '../../src/components/StructuredDiff/lineBudget.js'
import type { StructuredPatchHunk } from '../../src/utils/diff.js'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const MB = 1024 * 1024
const hunk: StructuredPatchHunk = {
  oldStart: 1,
  oldLines: 3,
  newStart: 1,
  newLines: 3,
  lines: [
    ' const before = 1',
    `+${'A'.repeat(MB)}`,
    `-${'z9/='.repeat(128 * 1024)}`,
    ' const after = 2',
  ],
}

// ── the bound + the honesty marker ──────────────────────────────────────────
const t0 = performance.now()
const bounded = boundPatchForRender(hunk)
const boundMs = performance.now() - t0

check('over-budget hunk maps to a new object', bounded !== hunk)
check('hunk geometry preserved',
  bounded.oldStart === 1 && bounded.newLines === 3 && bounded.lines.length === 4)
check('in-budget lines byte-identical',
  bounded.lines[0] === hunk.lines[0] && bounded.lines[3] === hunk.lines[3])

const ceiling = DIFF_LINE_RENDER_CAP + DIFF_LINE_MARKER_SLACK
for (const [i, line] of bounded.lines.entries()) {
  check(`line ${i} under the ceiling`, line.length <= ceiling, String(line.length))
}
check('added line keeps its + prefix', bounded.lines[1]!.startsWith('+A'))
check('removed line keeps its - prefix', bounded.lines[2]!.startsWith('-z'))
check('marker names the true added-line cut',
  bounded.lines[1]!.includes(`+${(MB + 1 - DIFF_LINE_RENDER_CAP).toLocaleString('en-US')} chars`),
  bounded.lines[1]!.slice(-70))
check('marker says where the full bytes live',
  bounded.lines[1]!.endsWith('the full line is in the file]'))

// ── the render-volume budget (the mechanism that bounds wrap rows) ──────────
const volume = bounded.lines.reduce((sum, line) => sum + line.length, 0)
check('bounded volume under lines × ceiling',
  volume <= bounded.lines.length * ceiling, String(volume))
check('bounding a 1.5MB hunk is linear-cheap (<100ms)', boundMs < 100, `${boundMs.toFixed(1)}ms`)

// ── identity laws (the per-hunk render cache keys on object identity) ───────
check('bounded twin is stable across calls', boundPatchForRender(hunk) === bounded)
const inBudget: StructuredPatchHunk = {
  oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
  lines: ['+short line'],
}
check('in-budget hunk returns the SAME object', boundPatchForRender(inBudget) === inBudget)
const edge: StructuredPatchHunk = {
  oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
  lines: [`+${'x'.repeat(DIFF_LINE_RENDER_CAP - 1)}`],
}
check('exactly-at-cap line is untouched', boundPatchForRender(edge) === edge)

console.log(failures === 0
  ? `\ndiff line budget: green (${checks} checks)`
  : `\ndiff line budget: ${failures} FAILURES of ${checks}`)
process.exit(failures === 0 ? 0 : 1)
