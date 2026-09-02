#!/usr/bin/env bun
// ============================================================================
//  scripts/interview/prove-question-card-state.ts — the question card's state
//  owners, pinned in-process: the projection the views paint from, the
//  select owner's focus seed, the options comparator, the two facts one row
//  can carry, and the empty-field door.
//
//    §1 the projection (questionState.ts): typed Other text outlives
//       navigation and re-render because it is projected from the newest
//       draft; the Other row is the selected one when the answer is free
//       text; a multi-select's Other row is in the selection exactly when
//       text is typed; a preview question's text is its note.
//    §2 the focus seed (use-select-navigation.ts): an options change keeps
//       the operator's highlight; the controlled value seeds only a list
//       that lost it.
//    §3 the comparator (option-map.ts): a handler swap is not a list change.
//    §4 the paint (the off-screen harness): a select whose highlight and
//       selection differ paints the pointer on one row and the tick on the
//       other; a multi-select paints its typed Other row checked.
//    §5 an empty Other never submits nothing: the single select reports an
//       empty ↵ to its caller instead of cancelling, the multi-select's
//       input door adds no row without text, and the card listens on both.
//
//  Run:  ~/.bun/bin/bun run scripts/interview/prove-question-card-state.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { OTHER_OPTION_VALUE, projectQuestionState } = await import(
  '../../src/components/permissions/AskUserQuestionPermissionRequest/questionState.ts'
)
const { focusSeedAfterOptionsChange } = await import('../../src/components/CustomSelect/use-select-navigation.ts')
const { optionsEquivalent } = await import('../../src/components/CustomSelect/option-map.ts')
type QuestionState = import('../../src/services/interview/contracts.ts').InterviewQuestionState
type Answer = import('../../src/services/interview/contracts.ts').InterviewAnswerValue

console.log('============================================================')
console.log(' The question card: state owners in-process')
console.log('============================================================')

// ── §1 the projection ──────────────────────────────────────────────────────
section('§1 the projection: text from the newest draft; the Other row as the selected one')
const options = [
  { id: 'io_a', label: 'Redis', description: 'Shared.' },
  { id: 'io_b', label: 'In-memory', description: 'Local.' },
  { id: 'io_c', label: 'File-based', description: 'Durable.' },
]
const single = { id: 'iq_1', decisionId: 'id_1', text: 'Which engine?', header: 'Engine', multiSelect: false, options }
const multi = { ...single, id: 'iq_2', decisionId: 'id_2', text: 'Which features?', multiSelect: true }
const state = (question: typeof single, over: Partial<QuestionState>): QuestionState => ({
  question,
  priorCommits: [],
  ...over,
})
const answer = (optionIds: string[], freeText?: string): Answer => ({ optionIds, ...(freeText !== undefined ? { freeText } : {}) })

{
  const p = projectQuestionState(state(single, { committed: answer(['io_a']), draft: answer(['io_a'], 'orchard') }))
  check('single: a committed option with typed text drafted keeps the option selected', p.selectedValue === 'Redis')
  check('single: …and projects the DRAFT text (typed text survives navigation and re-render)', p.textInputValue === 'orchard')
}
{
  const p = projectQuestionState(state(single, { committed: answer([], 'orchard') }))
  check('single: a free-text answer selects the Other row', p.selectedValue === OTHER_OPTION_VALUE)
  check('single: …with its text', p.textInputValue === 'orchard')
}
{
  const p = projectQuestionState(state(single, { draft: answer([], 'orchard') }))
  check('single: a draft alone selects nothing (no tick before a commit)', p.selectedValue === undefined)
  check('single: …but its text is projected', p.textInputValue === 'orchard')
}
{
  const p = projectQuestionState(state(single, {}))
  check('single: nothing answered projects no selection and no text', p.selectedValue === undefined && p.textInputValue === '')
}
{
  const p = projectQuestionState(state(multi, { committed: answer(['io_a', 'io_b'], 'plums') }))
  check(
    'multi: options plus typed text select the rows AND the Other row',
    Array.isArray(p.selectedValue) && p.selectedValue.join(',') === ['Redis', 'In-memory', OTHER_OPTION_VALUE].join(','),
    JSON.stringify(p.selectedValue),
  )
  check('multi: …with the text', p.textInputValue === 'plums')
}
{
  const p = projectQuestionState(state(multi, { committed: answer(['io_a']) }))
  check('multi: no text ⇒ the Other row is NOT in the selection', Array.isArray(p.selectedValue) && p.selectedValue.join(',') === 'Redis')
}
{
  const p = projectQuestionState(state(multi, { committed: answer(['io_a'], 'plums'), draft: answer(['io_a'], '') }))
  check('multi: an emptied field (a newer empty draft) drops the Other row and the text', Array.isArray(p.selectedValue) && p.selectedValue.join(',') === 'Redis' && p.textInputValue === '')
}
{
  const p = projectQuestionState(state(single, { committed: answer(['io_b']), note: 'keep it small' }))
  check('preview: the note is the projected text', p.textInputValue === 'keep it small' && p.selectedValue === 'In-memory')
}

// ── §2 the focus seed ──────────────────────────────────────────────────────
section('§2 the focus seed: the surviving highlight wins; the controlled value seeds a lost one')
const list = ['A', 'B', 'C', 'D', OTHER_OPTION_VALUE].map(value => ({ value, label: value }))
check(
  'the focused row survives the options change (never re-seeded from the selected answer)',
  focusSeedAfterOptionsChange({ focusedValue: OTHER_OPTION_VALUE, options: list, focusValue: 'A', initialFocusValue: undefined }) === OTHER_OPTION_VALUE,
)
check(
  'a focused row the new list lost falls to the controlled value',
  focusSeedAfterOptionsChange({ focusedValue: 'gone', options: list, focusValue: 'A', initialFocusValue: 'B' }) === 'A',
)
check(
  '…then to the initial seed',
  focusSeedAfterOptionsChange({ focusedValue: 'gone', options: list, focusValue: undefined, initialFocusValue: 'B' }) === 'B',
)
check(
  'no focus yet ⇒ the controlled value',
  focusSeedAfterOptionsChange({ focusedValue: undefined, options: list, focusValue: 'C', initialFocusValue: 'B' }) === 'C',
)

// ── §3 the comparator ──────────────────────────────────────────────────────
section('§3 the comparator: a handler swap is not a list change')
const inputRow = (over: Record<string, unknown>) => ({
  type: 'input' as const,
  value: OTHER_OPTION_VALUE,
  label: 'Other',
  initialValue: 'orchard',
  onChange: () => {},
  ...over,
})
check('the same rows with fresh handlers are equivalent', optionsEquivalent([{ value: 'A', label: 'A' }, inputRow({})], [{ value: 'A', label: 'A' }, inputRow({ onChange: () => {} })]))
check('a changed initial value is a list change', !optionsEquivalent([inputRow({})], [inputRow({ initialValue: 'orchards' })]))
check('a changed label is a list change', !optionsEquivalent([{ value: 'A', label: 'A' }], [{ value: 'A', label: 'B' }]))
check('a changed length is a list change', !optionsEquivalent([{ value: 'A', label: 'A' }], [{ value: 'A', label: 'A' }, { value: 'B', label: 'B' }]))

// ── §4 the paint ───────────────────────────────────────────────────────────
section('§4 the paint: the pointer and the tick are two facts')
try {
  const { enableConfigs } = await import('../../src/utils/config.ts')
  enableConfigs()
  const React = (await import('react')).default
  const { renderToString } = await import('../../src/utils/staticRender.tsx')
  const { Select, SelectMulti } = await import('../../src/components/CustomSelect/index.js')
  const rows = [
    { value: 'Redis', label: 'Redis', indexLabel: 'A.' },
    { value: 'In-memory', label: 'In-memory', indexLabel: 'B.' },
    { value: 'File-based', label: 'File-based', indexLabel: 'C.' },
    { value: 'Hybrid', label: 'Hybrid', indexLabel: 'D.' },
  ]
  const other = (initialValue: string) => ({
    type: 'input' as const,
    value: OTHER_OPTION_VALUE,
    label: 'Other',
    placeholder: 'Type something.',
    initialValue,
    onChange: () => {},
    indexLabel: 'E.',
  })
  const singleText = await renderToString(
    React.createElement(Select, {
      options: [...rows, other('orchard')] as never,
      defaultValue: OTHER_OPTION_VALUE,
      defaultFocusValue: 'In-memory',
      layout: 'compact-vertical',
    }),
    80,
  )
  const lines = singleText.split('\n')
  const pointerRow = lines.find(l => l.includes('❯'))
  const tickRow = lines.find(l => l.includes('✔'))
  check('single: the pointer paints on the highlighted row (B)', pointerRow !== undefined && pointerRow.includes('In-memory'), pointerRow ?? '(no pointer)')
  check('single: the tick paints on the selected row (E, with its text)', tickRow !== undefined && tickRow.includes('orchard'), tickRow ?? '(no tick)')
  check('single: they are different rows', pointerRow !== undefined && tickRow !== undefined && pointerRow !== tickRow)

  const multiText = await renderToString(
    React.createElement(SelectMulti, {
      options: [...rows, other('plums')] as never,
      defaultValue: ['In-memory', OTHER_OPTION_VALUE],
      onCancel: () => {},
      submitButtonText: 'Next',
      onSubmit: () => {},
    }),
    80,
  )
  const mlines = multiText.split('\n')
  const eRow = mlines.find(l => l.includes('plums'))
  const bRow = mlines.find(l => l.includes('In-memory'))
  const aRow = mlines.find(l => l.includes('Redis'))
  check('multi: the typed Other row paints checked', eRow !== undefined && eRow.includes('☒'), eRow ?? '(no row)')
  check('multi: the selected row paints checked, an unselected one unchecked', bRow !== undefined && bRow.includes('☒') && aRow !== undefined && aRow.includes('☐'))
} catch (e) {
  check('the off-screen harness rendered the selects', false, String(e).split('\n')[0])
}

// ── §5 the empty-field door ────────────────────────────────────────────────
section('§5 an empty Other never submits nothing')
const sel = readFileSync('src/components/CustomSelect/select.tsx', 'utf8')
const multiState = readFileSync('src/components/CustomSelect/use-multi-select-state.ts', 'utf8')
const qv = readFileSync('src/components/permissions/AskUserQuestionPermissionRequest/QuestionView.tsx', 'utf8')
check(
  'the single select reports an empty ↵ to its caller before it would cancel',
  /\} else if \(onEmptyInputSubmit\) \{\s*onEmptyInputSubmit\(optionValueOf\(option\)\)\s*\} else \{\s*onCancel\?\.\(\)/.test(sel),
)
check(
  'the multi-select input door adds no row without text and reports the empty ↵',
  /if \(text === ''\) \{\s*focusByValue\(value\)\s*if \(via === 'enter'\) onEmptyInputSubmit\?\.\(value\)\s*return\s*\}/.test(multiState),
)
check(
  'the multi-select’s ↵ on the focused input row takes the door, never the toggle',
  /key\.return && navigation\.isInInput && navigation\.focusedValue !== undefined\) \{\s*activateInputValue\(navigation\.focusedValue, 'enter'\)/.test(multiState),
)
check(
  'the card listens on both selects and paints the hint',
  /<SelectMulti[\s\S]*?onEmptyInputSubmit=\{showEmptyHint\}/.test(qv) && /<Select\s[\s\S]*?onEmptyInputSubmit=\{showEmptyHint\}/.test(qv) && qv.includes('Type something first'),
)
check('the card hands its tabs out of the multi-select (the documented key from every row)', /onTabOut=\{direction => \(direction === 'next' \? onTabNext\?\.\(\) : onTabPrev\?\.\(\)\)\}/.test(qv))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL QUESTION-CARD STATE PROOFS PASS')
else console.log(`❌ ${failures} QUESTION-CARD STATE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
