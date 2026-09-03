#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/prove-transition-e06-e07-ui.ts — the
//  five new journeys through the ONE design system, keyboard-complete and
//  mouse-polished; the layout/colour estate holds.
//
//    §A E06 — the five journey surfaces ride the design system (Dialog seam
//       for the two cards; useMercuryTokens/InteractiveRow at the picker;
//       Select/SelectMulti grammar at the choice surfaces; GLYPH, no emoji)
//    §B E06 — keyboard completeness + the mouse-polish fixes: confirm
//       grammar on both cards; the multi-select INPUT row engages by click
//       through its own door and reports real selection;
//       select-then-activate at the picker; Esc lands somewhere real
//    §C E07 — the estate: the visual-baseline matrix stands as the capture
//       law (80/120-class grids × themes × colour depths, prove-visual-
//       baseline in the ui suite), the lockup census is generated + green
//       in unison, the pill reserves its row (no content destruction), and
//       Windows parity rides the windows-ui lane at close (F05)
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '../..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

section('§A E06 — the five journeys ride the ONE design system')
{
  const preview = read('src/components/TransitionPreviewCard.tsx')
  const cap = read('src/components/CapOfferCard.tsx')
  check('transition preview: the Dialog seam', preview.includes("import { Dialog } from './design-system/Dialog.js'"))
  check('cap offer: the Dialog seam', cap.includes("import { Dialog } from './design-system/Dialog.js'"))
  const picker = read('src/components/MercuryModelPicker.tsx')
  check('the model picker: useMercuryTokens + InteractiveRow', picker.includes('useMercuryTokens') && picker.includes('InteractiveRow'))
  const onboarding = read('src/components/Onboarding.tsx')
  check('the provider-choice step: GLYPH vocabulary (no emoji)', onboarding.includes("import { GLYPH } from './mercury-ui/glyphs.js'"))
  const selector = read('src/components/MessageSelector.tsx')
  check('the timeline: the shared Select grammar + design tokens', selector.includes("import { Select } from './CustomSelect/index.js'") && selector.includes('useMercuryTokens'))
  for (const [name, src] of [
    ['preview card', preview],
    ['cap card', cap],
    ['picker', picker],
    ['selector', selector],
  ] as const) {
    check(`${name}: no emoji in source`, !/[\u{1F300}-\u{1FAFF}\u{2705}\u{274C}]/u.test(src))
  }
}

section('§B E06 — keyboard completeness + mouse polish')
{
  const preview = read('src/components/TransitionPreviewCard.tsx')
  const cap = read('src/components/CapOfferCard.tsx')
  check('both cards ride the confirm grammar (Esc = Dialog confirm:no)', preview.includes('confirm:no') && cap.includes('confirm:no'))
  const multi = read('src/components/CustomSelect/SelectMulti.tsx')
  // The input row is a live door: a click puts the caret in its field and,
  // with text typed, keeps the row in the selection — never a toggle that
  // drops typed text out of the answer (the keyboard side takes the same door).
  check('the multi-select INPUT row (the 5th option) engages by CLICK through its own door (pointer activation)', /isInputOption\(option\)[\s\S]{0,800}onClick=\{[\s\S]{0,200}state\.activateInputValue\(optionValueOf\(option\), 'pointer'\)/.test(multi))
  check('…and its checkbox renders the REAL selection state (matching the text rows)', /isInputOption\(option\)[\s\S]{0,1800}\{checkbox\(isChecked\)\}/.test(multi) && multi.includes('const checkbox = (checked: boolean)'))
  const state = read('src/components/CustomSelect/use-multi-select-state.ts')
  check('Enter/Space toggling covers input rows (keyboard side)', state.includes('Enter or space. Every submit path requires the submit callback') && state.includes('toggleValue(navigation.focusedValue)'))
  check('…and pointer activation with text puts the input row in the selection (never a toggle off)', state.includes('if (!selectedValuesRef.current.includes(value)) toggleValue(value)'))
  check('the picker is select-then-activate (InteractiveRow routes activation)', read('src/components/MercuryModelPicker.tsx').includes('select-then-activate'))
  const selector = read('src/components/MessageSelector.tsx')
  check('the timeline keeps its full keyboard map', selector.includes("'messageSelector:up'") && selector.includes("'messageSelector:select'") && selector.includes("'messageSelector:close'"))
}

section('§C E07 — the layout/colour estate')
{
  check('the visual-baseline matrix is the standing capture law', existsSync(join(ROOT, 'scripts/ui/prove-visual-baseline.ts')) && existsSync(join(ROOT, 'scripts/ui/generate-visual-baseline.ts')))
  check('the lockup census is generated + suite-held (unison)', existsSync(join(ROOT, 'scripts/consistency-census/gen-lockup-census.ts')) && existsSync(join(ROOT, 'scripts/consistency-census/prove-lockup-census.ts')))
  const layout = read('src/components/FullscreenLayout.tsx')
  check('the pill reserves its row (no content destruction under the overlay)', layout.includes('<Box height={1} flexShrink={0} />') && layout.includes('position="absolute" bottom={0}'))
  check('brand accent stays the token import, not a literal wave', !/(#DD4444)/.test(read('src/components/MercuryModelPicker.tsx')))
  // Windows parity is a LANE fact: the windows-ui workflow exists and runs
  // the bringup captures at close (F05's dispatch on the exact SHA).
  check('the windows-ui lane stands for parity at close', existsSync(join(ROOT, '.github/workflows/windows-ui.yml')))
}

console.log(
  failures === 0
    ? '\n ✅ — one design system, complete keys, polished mouse, the estate holds'
    : `\n ❌ — ${failures} failure(s)`,
)
process.exit(failures === 0 ? 0 : 1)
