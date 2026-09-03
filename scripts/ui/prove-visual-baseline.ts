#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-visual-baseline.ts — the baseline COMPARISON is
//  suite-reachable.
//
//  generate-visual-baseline.ts was the only thing that re-captures the
//  committed grids against the live product, and no runner globbed it (the
//  same orphaned-glob class its own header records) — so a rendering
//  regression in a non-dark family had NO standing proof. This prover closes
//  that: every pooled run re-captures a BOUNDED cross-family spot set (the
//  cockpit frame in light, daltonized and ansi — the families the dark-run
//  provers never see) and compares against the stored grids through the
//  mask-aware digests; UI_RENDER=1 runs the FULL 48-entry sweep.
//
//  Cost discipline: three PTY boots in the pooled lane (~30-45 s), the whole
//  matrix only in the render-class lane.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'

const FULL = process.env.UI_RENDER === '1'
const SPOTS = [
  'frame--120x40--light--truecolor--full',
  'frame--120x40--light-daltonized--truecolor--full',
  'frame--120x40--dark--ansi--full',
]

let fail = 0

// The mask vocabulary's checkout-name rows: the session tag bar carries the
// checkout's basename as the session's project chip, with the back hint
// right-aligned over a padding run — a different checkout (a sibling
// worktree, the hosted runner's clone) must grade equal to the recording
// box, like the statusbar rows already do.
{
  const { DEFAULT_MASKS, neutralizeGrid } = await import('./visualBaseline.ts')
  const oneRow = (text: string) => ({ schema: 1, cols: text.length, rows: 1, text: [text], styles: [[]] })
  const here = '◐ first task · mercury · ready' + ' '.repeat(82) + '⇧← back '
  const there = '◐ first task · a-much-longer-checkout-name · ready' + ' '.repeat(60) + '⇧← back '
  const same =
    neutralizeGrid(oneRow(here), DEFAULT_MASKS).text[0] === neutralizeGrid(oneRow(there), DEFAULT_MASKS).text[0]
  console.log(`  [${same ? 'PASS' : 'FAIL'}] the session tag bar canonicalizes across checkout basenames`)
  if (!same) fail = 1
  const composer = '│❯ Type a prompt, start a slash command, or Tab to focus the rails' + ' '.repeat(52) + '│'
  const kept = neutralizeGrid(oneRow(composer), DEFAULT_MASKS).text[0] === composer
  console.log(`  [${kept ? 'PASS' : 'FAIL'}] the composer row is not a tag-bar row (no mask fires)`)
  if (!kept) fail = 1

  // The stored text of a recording names no checkout: the generator
  // canonicalizes the checkout rows to one fixed spelling, width kept.
  const { canonicalizeCheckoutRows } = await import('./visualBaseline.ts')
  const band = '│ ▚▛▀▜▞ │ Opus 5 · ● high │ some-worktree ⌥fix/some-lane │ ⤳2' + ' '.repeat(56) + '│'
  const tag = '◐ first task · some-worktree · ready' + ' '.repeat(76) + '⇧← back '
  const grid = { schema: 1, cols: band.length, rows: 2, text: [band, tag], styles: [[], []] }
  const canon = canonicalizeCheckoutRows(grid, { basename: 'some-worktree', branch: 'fix/some-lane' })
  const spelled =
    canon.text[0].includes('│ mercury ⌥main │ ⤳2') && canon.text[1].startsWith('◐ first task · mercury · ready  ')
  const widths = canon.text[0].length === band.length && canon.text[1].length === tag.length
  const named = !canon.text.some(r => r.includes('some-worktree') || r.includes('some-lane'))
  console.log(`  [${spelled && widths && named ? 'PASS' : 'FAIL'}] the checkout rows store one fixed spelling at the captured width`)
  if (!(spelled && widths && named)) fail = 1
  const tight = { schema: 1, cols: 30, rows: 1, text: ['◐ t · m · ready' + ' '.repeat(7) + '⇧← back '], styles: [[]] }
  const left = canonicalizeCheckoutRows(tight, { basename: 'm', branch: 'x' }).text[0] === tight.text[0]
  console.log(`  [${left ? 'PASS' : 'FAIL'}] a name the fixed spelling would not fit is left as captured`)
  if (!left) fail = 1
}

const run = (only?: string): void => {
  const args = ['run', 'scripts/ui/generate-visual-baseline.ts', '--check']
  if (only) args.push('--only', only)
  const r = spawnSync(process.env.BUN ?? `${process.env.HOME}/.bun/bin/bun`, args, {
    encoding: 'utf8',
    timeout: FULL ? 1_800_000 : 300_000,
  })
  const tail = (r.stdout + r.stderr).split('\n').filter(Boolean).slice(-3).join(' · ')
  const ok = r.status === 0
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] baseline check ${only ?? 'FULL MATRIX'} — ${tail}`)
  if (!ok) fail = 1
}

console.log('visual baseline — the committed grids match the live product')
if (FULL) {
  run()
} else {
  for (const id of SPOTS) run(id)
}

if (fail) {
  console.log('❌ visual-baseline comparison RED')
  process.exit(1)
}
console.log('✅ visual-baseline comparison green')
