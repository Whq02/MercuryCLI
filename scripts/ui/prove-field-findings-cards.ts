#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-field-findings-cards.ts
// TASK-017 SUPPLEMENT 3 fixes — the cards and pickers.
//
//  Each section pins ONE fix with the finder's own driver-check re-expressed
//  as a Mac-runnable pure/source assertion and names the box drill that stays
//  NEEDS-REAL-BOX. Written under the box law (pins ride the fix; the suite
//  runs them at the pool).
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-field-findings-cards.ts
// ============================================================================
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

// ── §1 · PD-1: a capital N in the rejection field never approves the plan ──
// Finding PD-1 (important): the plan card registered confirm:approveWithFeedback
// (default shift+n) with no isActive gate; the decoder synthesises shift from
// case, so the first capital of "No, the migration…" typed into the 'No, keep
// planning' field APPROVED the plan and entered implement mode. The gate: a
// confirm chord never arms while a text field owns focus — the Select reports
// its focused option and the 'no' row IS the input row. The POISON is the
// finder's check inverted: the registration without the gate.
console.log('§1 PD-1 — the confirm chord disarms while the rejection field owns focus')
{
  // The mechanism, driven pure: a typed capital IS the shifted chord.
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
  // The class (the same disease at the shared consent body): PermissionPrompt's
  // option chords are bare/shifted letters in the Confirmation context and its
  // feedback rows are text fields.
  const prompt = read('src/components/permissions/PermissionPrompt.tsx')
  check(
    "PermissionPrompt's option chords carry the same gate while a feedback field owns focus",
    /useKeybindings\(keybindingHandlers, \{ context: 'Confirmation', isActive: [^}]*!inputOwnsFocus \}\)/.test(prompt) &&
      prompt.includes("(focusedFeedbackType === 'accept' && acceptInputMode) ||") &&
      prompt.includes("(focusedFeedbackType === 'reject' && rejectInputMode)"),
  )
  check("the Select's own accept/next/previous stay gated on isInInput (the owner's precedent)", read('src/components/CustomSelect/use-select-input.ts').includes("{ context: 'Select', isActive: !isDisabled && !state.isInInput },"))
}
// NEEDS-REAL-BOX (the finder's drill): enter strategy mode, let Mercury
// present a plan, arrow to "No, keep planning", type `No` — the N is inserted
// in the field and the card stands; shift+n on a Yes row still approves.

// ── §2 · PD-2: a digit never activates an ordinal the row does not paint ──
// Finding PD-2 (important): the /resume picker always takes the TreeSelect
// branch (isCustomTitleEnabled() is `return true`), which mounts the Select
// in the EXPANDED layout — the ordinal prefix is suppressed by the LAYOUT
// while the digit hotkey was fenced only by the hideIndexes FLAG, so a typed
// `3` resumed the third session with no '3.' ever on screen. The fence and
// the paint now read ONE predicate at the owner (select.tsx). POISON: the
// old fence spelling keyed on hideIndexes alone.
console.log('§2 PD-2 — the digit fence and the ordinal paint read one predicate')
{
  const select = read('src/components/CustomSelect/select.tsx')
  check('the one predicate exists (expanded layout ∨ hideIndexes)', select.includes("const ordinalsHidden = layout === 'expanded' || hideIndexes"))
  check("the digit fence reads it ('numeric' — Enter and scrolling stay live)", select.includes("disableSelection === false && ordinalsHidden ? 'numeric' : disableSelection"))
  check('the row paint reads the same predicate', select.includes("const prefix = ordinalsHidden ? '' : rowPrefix(option, option.index + 1, textRowReserved)"))
  check('POISON: the flag-only fence is gone', !select.includes("disableSelection === false && hideIndexes ? 'numeric' : disableSelection"))
  check("the owner's digit branch still honours 'numeric'", read('src/components/CustomSelect/use-select-input.ts').includes("disableSelection !== 'numeric'"))
  // The reachable picker: the tree branch is the live one and its layout is
  // expanded by default — the exact mount the finder traced.
  const tree = read('src/components/ui/TreeSelect.tsx')
  check('TreeSelect mounts the Select in the expanded layout by default', tree.includes("layout = 'expanded',") && tree.includes('layout={layout}'))
  check('the /resume picker always takes the tree branch (isCustomTitleEnabled is constant true)', /export function isCustomTitleEnabled\(\): boolean \{\s*\n\s*return true/.test(read('src/utils/sessionStorage/paths.ts')) && read('src/components/LogSelector.tsx').includes('const renaming = isCustomTitleEnabled()'))
}
// NEEDS-REAL-BOX: `mercury --resume` with ≥3 sessions, press `3` — a search
// box holding "3", no session resumed; ↵ still resumes the focused row.


// ── §3 · MGR-2: the plan card's Yes/No owns no key while focus is elsewhere ─
// Finding MGR-2 (important): the design lets tab move focus under a standing
// plan card ("the interview never imprisons the screen"), but the card's
// PermissionPrompt had no isDisabled, so its Select's ↵/esc/1/2 stayed live —
// ↵ on a board row DISPATCHED every lane. The prompt takes the focus fact
// (its Select disabled, its option chords gated) and the plan card hands it
// `!focused` exactly as the sibling ask card already did.
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
// NEEDS-REAL-BOX: wide terminal, a plan card standing, tab to the session
// list, ↵ on a row — the session opens; the card stands with its draft.

// ── §4 · MGR-1: the plan card fits the rows it is handed ────────────────────
// Finding MGR-1 (important): the card had no height budget — at 120×30 a
// two-lane plan ran ~23 rows against ~15, so the operator saw the goal and
// part of lane 1 and nothing else (no "Dispatch this plan?", no Yes/No, no
// composer) while the Select stayed live with Yes focused. The one pure fold
// picks the richest lane tier that fits; the prompt never gives.
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
// NEEDS-REAL-BOX: the concourse at 120×30, ⇧tab on the coordinator composer,
// a goal, answer to a plan — "Dispatch this plan?", the Yes/No rows and the
// composer all stand at the pane foot; repeat at 100×30 and 120×40.

// ── §5 · PD-8 — the cap-offer card prints ONE true hint line ────
// The finder: two key-hint lines that disagreed ('enter to confirm · esc to
// cancel' from Dialog's default guide under the card's own line), the
// shared one advertising an enter the card keeps INERT while the lane is
// unusable. The card's line now rides Dialog's inputGuide seam — the only
// line printed is the true one, esc spelled by the same resolver Dialog
// uses, and the unusable arm never names enter.
console.log('§5 PD-8 — cap-offer: one hint line, the dead enter never advertised')
{
  const card = read('src/components/CapOfferCard.tsx')
  check('the card rides the inputGuide seam (Dialog default guide replaced)', card.includes('inputGuide={() => ('))
  check("esc's spelling rides the resolver (the same one Dialog reads)", card.includes("useShortcutDisplay('confirm:no', 'Confirmation', 'esc')"))
  // The guide expression: `usable ? <enter arm> : <esc-only arm>` — the
  // unusable arm (the dead-enter state) must never name enter.
  const guide = card.slice(card.indexOf('inputGuide={'), card.indexOf('    >', card.indexOf('inputGuide={')))
  const unusableArm = guide.slice(guide.indexOf(' : '))
  check('the guide was found with both arms', guide.includes('usable') && guide.includes(' : ') && unusableArm.length > 10, `guide ${guide.length}b`)
  check('the usable arm advertises enter; the unusable arm only esc', guide.includes('`enter opens the transition preview') && !/enter/.test(unusableArm))
  check('POISON: the body no longer paints its own second hint line', !card.includes('? `enter opens the transition preview ${GLYPH.dot} esc stays put`'))
}

// ── §6 · PD-9 — the inline model picker advertises its keys ─────
// The finder: the inline mount painted no key hints at all — esc and enter
// unspoken (the standalone printed 'enter confirm · esc exit'). The inline
// now prints the family line with the truth-word for where its esc lands
// ('esc close' — back to the composer), press-again outranking it.
console.log('§6 PD-9 — inline model picker: keys advertised')
{
  const picker = read('src/components/ModelPicker.tsx')
  check('POISON: the bare inline return (no guide) is gone', !/if \(!isStandaloneCommand\) return body/.test(picker))
  check("the inline guide prints 'enter confirm · esc close' under the press-again gate", picker.includes("'enter confirm · esc close'") && /if \(!isStandaloneCommand\) \{[^]{0,600}exitState\.pending/.test(picker))
  check('the standalone keeps its own line', picker.includes("'enter confirm · esc exit'"))
}

// ── §7 · PD-5 — "…and N more below" follows the scroll ──────────
// The finder: the row was a fixed count (options minus the window size)
// that never changed as the list scrolled. The Select now reports its
// painted window (onVisibleWindowChange — a render-state notification, an
// effect keyed on the window's own bounds; nothing in the select reads
// it), and the picker counts what is actually below, reaching 0 (row gone)
// at the bottom.
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
