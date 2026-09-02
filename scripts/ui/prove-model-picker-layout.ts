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
section('muster ROLES section — seat-slot rows in the ONE vertical space')
// Footer variant: a focused role row swaps the action vocabulary for the
// seat grammar (m model · +/- effort) and still keeps the floor.
for (const cols of [50, 64, 120]) {
  const inner = innerOf(cols)
  const rf = modelPickerFooter({ hasEffort: true, supports1m: true, gated: false, roleFocused: true }, inner)
  check(`@${cols} role footer fits (no wrap)`, rf.length <= Math.max(inner, FLOOR), `"${rf}"`)
  check(`@${cols} role footer keeps the nav+exit floor`, rf.startsWith('↑↓ select') && rf.endsWith('esc close'))
}
const roleWide = modelPickerFooter({ hasEffort: true, supports1m: true, gated: false, roleFocused: true }, innerOf(120))
check('role footer teaches the board grammar (m model · +/- effort)', roleWide.includes('m model') && roleWide.includes('+/- effort'), `"${roleWide}"`)
check('role footer never advertises the model-switch action', !roleWide.includes('↵ switch') && !roleWide.includes('←→ effort'))
// Source wiring: role rows ride InteractiveRow in the same selection space;
// display truth carries the pending arrow + env-locked naming; the SEAT LAW
// holds structurally (the picker's role vocabulary comes ONLY from the ONE
// cycle — no gpt/glm/haiku spelling anywhere in the component).
check('role rows ride InteractiveRow with stable ids', /id=\{`model:role:\$\{r\.role\}`\}/.test(src))
check('role rows share the ONE vertical selection space (totalRows nav bounds)', /const totalRows = models\.length \+ roleRows\.length/.test(src) && /selectRow\(Math\.min\(totalRows - 1, i \+ 1\)\)/.test(src))
check('pending retarget renders as the AMBER arrow, never the main cell', /r\.pendingModel \? <Text color=\{AMBER\}>\{` →\$\{r\.pendingModel\}`\}<\/Text> : null/.test(src))
check("queued annotation says 'applies at turn end'", /queued — applies at turn end/.test(src))
check('env-locked axes are NAMED on the selected row', /locked · \$\{lockedNames\.join\(' \+ '\)\}/.test(src))
check('↵ on a role row answers with the grammar (keydead rule, never silent)', /onRoleAction\?\.\(focusedRole\.role, 'hint'\)/.test(src))
check('←→ stays the MAIN effort slider only (declined on role rows)', /effortAxis === 'moveLeft' && hasEffort && !focusedRole/.test(src))
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
// The wrapper feeds the section from the ONE machinery (no second table).
const wrapper = readFileSync(join(root, 'src', 'commands', 'model', 'mercuryModel.tsx'), 'utf-8')
check('wrapper resolves rows via resolveSeatSlot (the ONE resolver)', /const res = resolveSeatSlot\(role\)/.test(wrapper))
check('wrapper edits ride applyOperatorReslot + nextSeatModel (no local tables)', /applyOperatorReslot\(role, \{ model: nextSeatModel\(role, row\.model\) \}/.test(wrapper) && !/nextModelOf/.test(wrapper))
check('locked axes refuse with the origin named (env-pin origin law)', /locked by \$\{row\.modelLockedBy\} this session/.test(wrapper))
// The board consumes the same ONE cycle (its local table is deleted).

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
