#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const count = (hay: string, needle: string): number => hay.split(needle).length - 1

let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('§1 PD-1 — the confirm chord disarms while the rejection field owns focus')
{
  const { interpretKey } = await import('../../src/ink/input/interpreter.ts')
  const { matchesKeystroke } = await import('../../src/keybindings/match.ts')
  const { parseKeystroke } = await import('../../src/keybindings/parser.ts')
  const parsed = interpretKey('N')
  check("the decoder names a typed 'N' as shift+n (shift synthesised from case)", parsed.name === 'n' && parsed.shift === true)
  const key = { ctrl: false, meta: false, shift: true, super: false } as unknown as Parameters<typeof matchesKeystroke>[1]
  check("the matcher accepts that keystroke for the 'shift+n' binding — why the gate must exist", matchesKeystroke('N', key, parseKeystroke('shift+n')))
  const card = read('src/components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx')
  check(
    'POISON: the ungated registration is gone (the chord carries the field-owns-focus gate)',
    !/'confirm:approveWithFeedback',\s*\n(?:.*\n){1,6}?\s*\{ context: 'Confirmation' \},\s*\n\s*\)/.test(card) &&
      card.includes("{ context: 'Confirmation', isActive: !rejectionFieldFocused },"),
  )
  check("the 'No, keep planning' row is the input row", /type: 'input',\s*\n\s*label: 'No, keep planning',\s*\n\s*value: 'no',/.test(card))
  check(
    'BOTH Select mounts (sticky footer + inline) report the focused option to the gate',
    count(card, "onFocus={value => setRejectionFieldFocused(value === 'no')}") === 2,
  )
  check('a re-registered sticky Select resets the gate (it starts on its first row, never the input row)', card.includes('setRejectionFieldFocused(false)\n    setStickyFooter('))
  const prompt = read('src/components/permissions/PermissionPrompt.tsx')
  check(
    "PermissionPrompt's option chords carry the same gate while a feedback field owns focus",
    /useKeybindings\(keybindingHandlers, \{ context: 'Confirmation', isActive: [^}]*!inputOwnsFocus \}\)/.test(prompt) &&
      prompt.includes("(focusedFeedbackType === 'accept' && acceptInputMode) ||") &&
      prompt.includes("(focusedFeedbackType === 'reject' && rejectInputMode)"),
  )
  check("the Select's own accept/next/previous stay gated on isInInput (the owner's precedent)", read('src/components/CustomSelect/use-select-input.ts').includes("{ context: 'Select', isActive: !isDisabled && !state.isInInput },"))
}

console.log('§2 PD-2 — the digit fence and the ordinal paint read one predicate')
{
  const select = read('src/components/CustomSelect/select.tsx')
  check('the one predicate exists (expanded layout ∨ hideIndexes)', select.includes("const ordinalsHidden = layout === 'expanded' || hideIndexes"))
  check("the digit fence reads it ('numeric' — Enter and scrolling stay live)", select.includes("disableSelection === false && ordinalsHidden ? 'numeric' : disableSelection"))
  check('the row paint reads the same predicate', select.includes("const prefix = ordinalsHidden ? '' : rowPrefix(option, option.index + 1, textRowReserved)"))
  check('POISON: the flag-only fence is gone', !select.includes("disableSelection === false && hideIndexes ? 'numeric' : disableSelection"))
  check("the owner's digit branch still honours 'numeric'", read('src/components/CustomSelect/use-select-input.ts').includes("disableSelection !== 'numeric'"))
  const tree = read('src/components/ui/TreeSelect.tsx')
  check('TreeSelect mounts the Select in the expanded layout by default', tree.includes("layout = 'expanded',") && tree.includes('layout={layout}'))
  check('the /resume picker always takes the tree branch (isCustomTitleEnabled is constant true)', /export function isCustomTitleEnabled\(\): boolean \{\s*\n\s*return true/.test(read('src/utils/sessionStorage/paths.ts')) && read('src/components/LogSelector.tsx').includes('const renaming = isCustomTitleEnabled()'))
}


console.log('§3 MGR-2 — a tabbed-away plan card owns no key')
{
  const prompt = read('src/components/permissions/PermissionPrompt.tsx')
  check('PermissionPrompt takes isDisabled and hands it to its Select', prompt.includes('isDisabled?: boolean') && prompt.includes('isDisabled = false,') && prompt.includes('isDisabled={isDisabled}'))
  check('its option chords are gated on the same fact', prompt.includes("{ context: 'Confirmation', isActive: !isDisabled && !inputOwnsFocus }"))
  const cards = read('src/components/concourse/ManagerCards.tsx')
  const plan = cards.slice(cards.indexOf('export function ManagerPlanCard'), cards.indexOf('export function ManagerSeatAskCard'))
  check('the plan card hands the prompt its focus fact', plan.includes('isDisabled={!focused}') && plan.includes('question="Dispatch this plan?"'))
  check("the card's own s toggle stays focus-gated (the precedent)", plan.includes('{ isActive: focused && !busy },'))
  check('the sibling ask card keeps its own gate (one law, both cards)', cards.slice(0, cards.indexOf('export function ManagerPlanCard')).includes('isDisabled={!focused}'))
  check("the Select's raw path honours isDisabled (why the fact settles every key)", read('src/components/CustomSelect/use-select-input.ts').includes('{ isActive: !isDisabled },'))
}

console.log('§4 MGR-1 — the plan card yields its lanes block, never its prompt')
{
  const { planCardLayout, planCardFixedRows, laneRowsFor } = await import('../../src/components/concourse/planCardLayout.ts')
  const lane = (n: number) => ({ title: `lane ${n}`, scope: 'x'.repeat(70), deliverables: 'y'.repeat(70), territory: `src/part${n}/**` })
  const plan = { goal: 'a goal that fits one line', lanes: [lane(1), lane(2)], seats: '2 of 5', supervision: 'supervising' as const, state: 'proposed' as const }
  const w = 38
  check('no budget ⇒ the full tier, every lane', planCardLayout(plan, undefined, w).tier === 'full' && planCardLayout(plan, undefined, w).hidden === 0)
  const fixed = planCardFixedRows(plan, w)
  const full = plan.lanes.reduce((n, l) => n + laneRowsFor(l, 'full', w), 0)
  check('the fixed rows count the frame, the goal, the seats, the supervision row and the PROMPT BLOCK WHOLE (marginTop + question + options + legend + bottom border — FC-063: the old four-row count let six-lane plans eat two composer rows)', fixed === 3 + 1 + 1 + 2 + 6)
  check('a roomy budget keeps the full tier', planCardLayout(plan, fixed + full, w).tier === 'full')
  const at120x30 = 15
  const tight = planCardLayout(plan, at120x30, w)
  check("the finder's 120×30 budget (~15 rows) drops to a tier that fits — the prompt survives", tight.tier !== 'full' && tight.lanesRows <= at120x30 - fixed && tight.shown === 2 && tight.hidden === 0, JSON.stringify(tight))
  const six = { ...plan, lanes: [1, 2, 3, 4, 5, 6].map(lane) }
  const cramped = planCardLayout(six, fixed + 4, w)
  check('six lanes in four rows: titles tier, three shown, three counted on the tail — never zero, never silent', cramped.tier === 'titles' && cramped.shown === 3 && cramped.hidden === 3 && cramped.lanesRows === 4, JSON.stringify(cramped))
  check('a budget below the fixed rows still paints one lane', planCardLayout(six, 2, w).shown === 1)
  const cards = read('src/components/concourse/ManagerCards.tsx')
  check('the card reads the fold and clips its lanes block to the granted rows', cards.includes('const layout = planCardLayout(plan, maxRows, Math.max(16, textWidth ?? 38))') && cards.includes("{...(maxRows !== undefined ? { height: layout.lanesRows, overflow: 'hidden' as const } : {})}"))
  check('the tail line names the lanes not shown and what Yes still starts', cards.includes('more lane{layout.hidden === 1 ? \'\' : \'s\'} — not shown at this height; Yes starts all {plan.lanes.length}'))
  check('the harmony fence paints in every tier', cards.includes("layout.tier === 'titles' ? (") && cards.includes('territory: {lane.territory}'))
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  check('the screen hands the card the slot rows minus the composer band and the pane title', screen.includes('maxRows={Math.max(8, rows - (Math.max(1, Math.min(coordBandDesired, rows - 8)) + 3) - 3)}') && screen.includes('textWidth={Math.max(16, width - 8)}'))
}

console.log('§5 PD-8 — cap-offer: one hint line, the dead enter never advertised')
{
  const card = read('src/components/CapOfferCard.tsx')
  check('the card rides the inputGuide seam (Dialog default guide replaced)', card.includes('inputGuide={() => ('))
  check("esc's spelling rides the resolver (the same one Dialog reads)", card.includes("useShortcutDisplay('confirm:no', 'Confirmation', 'esc')"))
  const guide = card.slice(card.indexOf('inputGuide={'), card.indexOf('    >', card.indexOf('inputGuide={')))
  const unusableArm = guide.slice(guide.indexOf(' : '))
  check('the guide was found with both arms', guide.includes('usable') && guide.includes(' : ') && unusableArm.length > 10, `guide ${guide.length}b`)
  check('the usable arm advertises enter; the unusable arm only esc', guide.includes('`enter opens the transition preview') && !/enter/.test(unusableArm))
  check('POISON: the body no longer paints its own second hint line', !card.includes('? `enter opens the transition preview ${GLYPH.dot} esc stays put`'))
}

console.log('§6 PD-9 — inline model picker: keys advertised')
{
  const picker = read('src/components/ModelPicker.tsx')
  check('POISON: the bare inline return (no guide) is gone', !/if \(!isStandaloneCommand\) return body/.test(picker))
  check("the inline guide prints 'enter confirm · esc close' under the press-again gate", picker.includes("'enter confirm · esc close'") && /if \(!isStandaloneCommand\) \{[^]{0,600}exitState\.pending/.test(picker))
  check('the standalone keeps its own line', picker.includes("'enter confirm · esc exit'"))
}

console.log('§7 PD-5 — the more-below count rides the painted window')
{
  const select = read('src/components/CustomSelect/select.tsx')
  check('the Select carries the render-state seam', select.includes('onVisibleWindowChange?: (visibleFromIndex: number, visibleToIndex: number) => void'))
  check('the effect keys on the window bounds themselves', /useEffect\(\(\) => \{\s*\n\s*onVisibleWindowChange\?\.\(visibleFromIndex, visibleToIndex\)\s*\n\s*\}, \[onVisibleWindowChange, visibleFromIndex, visibleToIndex\]\)/.test(select))
  const picker = read('src/components/ModelPicker.tsx')
  check('the picker derives the count from the reported window', picker.includes('onVisibleWindowChange={(_, to) => setVisibleTo(to)}') && picker.includes('Math.max(0, options.length - visibleTo)'))
  check('POISON: the fixed mount-time count is gone', !picker.includes('Math.max(0, options.length - VISIBLE_OPTIONS)'))
}

process.exit(failures === 0 ? 0 : 1)
