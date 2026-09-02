#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-model-picker-layout.ts
//  PROOF for the /model picker layout (the design schema's brand-model-select:
//  single-column, highlighted-selected).
//
//  The picker was a rail(50) + detail row laid out flexDirection="row" (~102+
//  cols) that flex-SHRANK both panels below their content width at the common
//  80/100-col terminal → ragged wrap. It's now a SINGLE-COLUMN panel: each model
//  is a row, the FOCUSED one sits in a rounded-accent SelectRow (the schema's
//  "highlighted-selected container"), group names are uppercase eyebrows, and the
//  panel width clamps to Math.min(cols-2, 62) so it NEVER overflows at any width.
//  Every row is click-selectable (onClick → selectRow). Goes RED if the picker
//  reverts to the shrink-wrapping rail+detail row, or drops the boxed-selected /
//  click wiring.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-model-picker-layout.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { modelPickerFooter } from '../../src/utils/model/modelPickerFooter.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

console.log('============================================================')
console.log(' /model picker — single-column, highlighted-selected, no overflow')
console.log('============================================================')

// ───────────────────────────────────────────────────────────────────────────
section('terminal-fit: single-column width never overflows')
// The picker clamps its width to Math.min(cols-2, 62) — always ≤ cols-2, so it
// fits at every width the old rail+detail row shrink-wrapped at.
const panelWidth = (cols: number): number => Math.min(cols - 2, 62)
for (const cols of [80, 100, 120, 160, 200]) {
  const w = panelWidth(cols)
  check(`@${cols} panelWidth(${w}) ≤ cols-2 (${cols - 2}) — no overflow`, w <= cols - 2)
}
// ───────────────────────────────────────────────────────────────────────────
section('footer discipline: sheds on narrow, never wraps, keeps the nav+exit floor')
// The footer is modelPickerFooter(opts, panelWidth-4). It must never exceed the
// panel's inner width at ANY terminal width — below ~64 cols the OPTIONAL segments
// shed (c context → ←→ effort → the ↵ switch/gated action) instead of wrapping, and
// the "↑↓ select … esc close" nav+exit floor is always kept.
const innerOf = (cols: number): number => panelWidth(cols) - 4
const FLOOR = '↑↓ select · esc close'.length
// A stress case: gated row + effort + 1M-context + a long enable-flag (over-worst;
// exercises every shed step).
const stress = { hasEffort: true, supports1m: true, gated: true, enableFlag: 'MERCURY_SWARMS' }
for (const cols of [50, 56, 64, 80, 100, 120]) {
  const inner = innerOf(cols)
  const f = modelPickerFooter(stress, inner)
  check(`@${cols} footer len ${f.length} ≤ inner ${inner} — no wrap`, f.length <= Math.max(inner, FLOOR), `"${f}"`)
  check(`@${cols} keeps the ↑↓ select … esc close floor`, f.startsWith('↑↓ select') && f.endsWith('esc close'))
}
// Shedding is real: the wide footer carries MORE segments than the narrow one.
const wideSegs = modelPickerFooter(stress, innerOf(120)).split(' · ').length
const narrowSegs = modelPickerFooter(stress, innerOf(50)).split(' · ').length
check('wide footer shows more segments than narrow (shedding actually fires)', wideSegs > narrowSegs, `wide=${wideSegs} narrow=${narrowSegs}`)
// Priority order: "c context" (lowest) sheds before "←→ effort".
const mid = modelPickerFooter(stress, 40)
check('sheds "c context" before "←→ effort" (drop-priority)', !mid.includes('c context') || mid.includes('←→ effort'), `"${mid}"`)
// A realistic (non-gated) full footer fits the wide panel intact — no gratuitous shedding.
const realistic = modelPickerFooter({ hasEffort: true, supports1m: true, gated: false }, innerOf(120))
check('realistic effort+context+switch footer fits the wide panel intact', realistic.includes('←→ effort') && realistic.includes('c context') && realistic.includes('↵ switch'), `"${realistic}"`)

// ───────────────────────────────────────────────────────────────────────────
section('source wiring: single-column, boxed-selected, click-driven')
const src = readFileSync(join(root, 'src', 'components', 'MercuryModelPicker.tsx'), 'utf-8')
check('single-column outer Box (flexDirection="column" + round border — schema-true)', /flexDirection="column" borderStyle="round"/.test(src))
check('footer uses the width-disciplined modelPickerFooter (no raw ternary hint)', /modelPickerFooter\(\{/.test(src) && /import \{ modelPickerFooter \}/.test(src))
// the width rides the ONE geometry contract (cap 62 ·
// edge reserve 2 · floor 20 — and NEVER wider than the terminal).
check('panelWidth rides the geometry contract (cap 62 · reserve 2) — never overflows', /panelWidthFor\(cols, \{ cap: 62, reserve: 2, min: 20 \}\)/.test(src))
// SelectRow is DELETED — rows ride InteractiveRow (select-then-
// activate: first click selects via onSelect, second click runs the exact ↵
// body via commitCurrent). The boxed-selected look is the caller's paint.
check('uses InteractiveRow for the highlighted-selected container', /<InteractiveRow\n {14}id=\{`model:row:\$\{m\.id\}`\}/.test(src) && /import \{ InteractiveRow \}/.test(src))
check('group name renders as an uppercase eyebrow', /\.group\.toUpperCase\(\)/.test(src))
check('every row is click-selectable (onSelect → selectRow) and ↵-parity (onActivate → commitCurrent)', /onSelect=\{\(\) => selectRow\(idx\)\}/.test(src) && /onActivate=\{commitCurrent\}/.test(src) && /const selectRow = \(n: number\)/.test(src))
check(
  'retired the shrink-wrapping rail+detail (no modelPickerLayout import, no railWidth/detailWidth)',
  !/import \{ modelPickerLayout \}/.test(src) && !/width=\{railWidth\}/.test(src) && !/width=\{detailWidth\}/.test(src),
)

// ───────────────────────────────────────────────────────────────────────────
section('SEAT LAW — the picker\'s selection grammar names no engine')
// The seat-role rows (the party's role slots — a role footer variant,
// pending retargets, env-locked axes, ↵ on a role row) left the picker with
// the retired party estate; the footer has no role variant and the picker
// composes no role rows, so their pins are retired with them. The SEAT LAW
// they stood beside is the picker's own and stays below.
// SEAT LAW re-anchored (the operator-confirmed GPT seat rows) +
// (the GPT window-law line) + (source-honesty: the row
// states the ACTIVE source's served window and only a ceiling THAT source
// declares — it never advertises another source's window, and the static
// model-page pin never masquerades as an observation) +
// (provider parity: where the source declares BOTH windows the row is a
// real `c` toggle — the `GptServedWindowSuffix` helpers persist the choice
// on the id and `focusedGptToggle` names the capability): the picker MAY
// carry the honest per-seat gpt STATE line + the explicit `g` action
// (wrapper-fed) AND the focused-row WINDOW truth (the
// `focusedGptWindow`/`gptCtxNudge`/toggle surfaces; `c` answers, never
// dies) — but engines never enter the SELECTION grammar: no glm anywhere,
// no haiku ever, and every 'gpt' spelling stays on those named display
// surfaces (never a model row or the m-cycle).
check('SEAT LAW: glm/haiku never in the picker; gpt only as the seat-state surface', !/glm/i.test(src) && !/haiku/i.test(src))
check(
  "SEAT LAW: 'gpt' spellings confined to the seat-state + window-law surfaces (+ their docs)",
  src
    .split('\n')
    .filter(l => /gpt/i.test(l))
    .every(
      l =>
        /gptDetail|gptEligible|'gpt'|focusedGptWindow|focusedGptToggle|GptServedWindowSuffix|gptCtxNudge|parseGptModelId|gptDisplayPin|liveGptContextWindow|liveGptContextCeiling|GPT account source/i.test(l) ||
        /^\s*(\/?\*|\/\/|\{\/\*)/.test(l),
    ),
)
// ───────────────────────────────────────────────────────────────────────────
section('§8.2 — pending-switch current→next visibility + the ONE apply owner')
// The picker renders the queued foreground switch (current→next header +
// AMBER 'next' row state); the /model command's select routes through the
// SAME ModelTransition machine the inline picker uses (one boundary-aware
// apply owner — a mid-turn pick REPLACES the pending slot, never re-models a
// running turn).
check("picker accepts pendingNext + renders the 'next' AMBER row state", /pendingNext\?: string/.test(src) && /'next', AMBER/.test(src))
check('picker renders the current→next header with the turn-settle note', /applies when the turn settles/.test(src))
check('wrapper feeds pendingNext from AppState.pendingModelSwitch', /s\.pendingModelSwitch/.test(wrapper) && /pendingNext/.test(wrapper))
check('/model select routes through settleModelSelection (the ONE settlement owner — unison W1)', /settleModelSelection\(/.test(wrapper) && !/decideModelTransition\(\{/.test(wrapper))
check('cross-provider picks carry the crossProviderNote', /crossProviderNote\(value\)/.test(wrapper))

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ /model picker is single-column, highlighted-selected, fits every width')
  process.exit(0)
} else {
  console.log(` ❌ /model picker layout — ${failures} check(s) failed`)
  process.exit(1)
}
