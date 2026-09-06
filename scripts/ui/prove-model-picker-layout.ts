#!/usr/bin/env bun
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

section('terminal-fit: single-column width never overflows')
const panelWidth = (cols: number): number => Math.min(cols - 2, 62)
for (const cols of [80, 100, 120, 160, 200]) {
  const w = panelWidth(cols)
  check(`@${cols} panelWidth(${w}) ≤ cols-2 (${cols - 2}) — no overflow`, w <= cols - 2)
}
section('footer discipline: sheds on narrow, never wraps, keeps the nav+exit floor')
const innerOf = (cols: number): number => panelWidth(cols) - 4
const FLOOR = '↑↓ select · esc close'.length
const stress = { hasEffort: true, supports1m: true, gated: true, enableFlag: 'MERCURY_TEAMMATES' }
for (const cols of [50, 56, 64, 80, 100, 120]) {
  const inner = innerOf(cols)
  const f = modelPickerFooter(stress, inner)
  check(`@${cols} footer len ${f.length} ≤ inner ${inner} — no wrap`, f.length <= Math.max(inner, FLOOR), `"${f}"`)
  check(`@${cols} keeps the ↑↓ select … esc close floor`, f.startsWith('↑↓ select') && f.endsWith('esc close'))
}
const wideSegs = modelPickerFooter(stress, innerOf(120)).split(' · ').length
const narrowSegs = modelPickerFooter(stress, innerOf(50)).split(' · ').length
check('wide footer shows more segments than narrow (shedding actually fires)', wideSegs > narrowSegs, `wide=${wideSegs} narrow=${narrowSegs}`)
const mid = modelPickerFooter(stress, 40)
check('sheds "c context" before "←→ effort" (drop-priority)', !mid.includes('c context') || mid.includes('←→ effort'), `"${mid}"`)
const realistic = modelPickerFooter({ hasEffort: true, supports1m: true, gated: false }, innerOf(120))
check('realistic effort+context+switch footer fits the wide panel intact', realistic.includes('←→ effort') && realistic.includes('c context') && realistic.includes('↵ switch'), `"${realistic}"`)

section('source wiring: single-column, boxed-selected, click-driven')
const src = readFileSync(join(root, 'src', 'components', 'MercuryModelPicker.tsx'), 'utf-8')
check('single-column outer Box (flexDirection="column" + round border — schema-true)', /flexDirection="column" borderStyle="round"/.test(src))
check('footer uses the width-disciplined modelPickerFooter (no raw ternary hint)', /modelPickerFooter\(\{/.test(src) && /import \{ modelPickerFooter \}/.test(src))
check('panelWidth rides the geometry contract (cap 62 · reserve 2) — never overflows', /panelWidthFor\(cols, \{ cap: 62, reserve: 2, min: 20 \}\)/.test(src))
check('uses InteractiveRow for the highlighted-selected container', /<InteractiveRow\n {14}id=\{`model:row:\$\{m\.id\}`\}/.test(src) && /import \{ InteractiveRow \}/.test(src))
check('group name renders as an uppercase eyebrow', /\.group\.toUpperCase\(\)/.test(src))
check('every row is click-selectable (onSelect → selectRow) and ↵-parity (onActivate → commitCurrent)', /onSelect=\{\(\) => selectRow\(idx\)\}/.test(src) && /onActivate=\{commitCurrent\}/.test(src) && /const selectRow = \(n: number\)/.test(src))
check(
  'retired the shrink-wrapping rail+detail (no modelPickerLayout import, no railWidth/detailWidth)',
  !/import \{ modelPickerLayout \}/.test(src) && !/width=\{railWidth\}/.test(src) && !/width=\{detailWidth\}/.test(src),
)

section('SEAT LAW — the picker\'s selection grammar names no engine')
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
section('§8.2 — pending-switch current→next visibility + the ONE apply owner')
const wrapper = readFileSync(join(root, 'src', 'commands', 'model', 'mercuryModel.tsx'), 'utf-8')
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
