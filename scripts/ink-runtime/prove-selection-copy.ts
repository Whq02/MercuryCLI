#!/usr/bin/env bun
import {
  clearSelection,
  createSelectionState,
  finishSelection,
  getSelectedText,
  startSelection,
  updateSelection,
} from '../../src/ink/geometry/selection.js'
import {
  composeScene,
  type FrameScene,
  makeContext,
  screenLines,
} from './frameHarness.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const scene: FrameScene = {
  name: 'selection',
  cols: 30,
  rows: 6,
  root: {
    kind: 'box',
    style: { flexDirection: 'column' },
    children: [
      { kind: 'text', text: 'first line of text' },
      { kind: 'text', text: 'あい漢字 wide row' },
      { kind: 'text', text: 'third row here' },
    ],
  },
}

console.log('bedrock selection copy — grapheme-aware range laws')

const frame = composeScene(scene, makeContext())
const before = screenLines(frame.screen).join('\n')

function drag(from: [number, number], to: [number, number]): string {
  const s = createSelectionState()
  startSelection(s, from[0], from[1])
  updateSelection(s, to[0], to[1])
  finishSelection(s)
  const text = getSelectedText(s, frame.screen)
  clearSelection(s)
  return text
}

check(
  'full first row copies exactly',
  drag([0, 0], [29, 0]) === 'first line of text',
  JSON.stringify(drag([0, 0], [29, 0])),
)

check(
  'partial range copies the visible slice',
  drag([6, 0], [9, 0]) === 'line',
  JSON.stringify(drag([6, 0], [9, 0])),
)

{
  const text = drag([6, 0], [4, 2])
  check(
    'multi-row drag copies the screen-linear range',
    text === 'line of text\nあい漢字 wide row\nthird',
    JSON.stringify(text),
  )
}

{
  const acrossHead = drag([0, 1], [5, 1])
  check('drag ending on a wide head keeps the whole glyph', acrossHead === 'あい漢', JSON.stringify(acrossHead))
  const acrossTail = drag([1, 1], [6, 1])
  check(
    'drag from a wide tail still yields whole glyphs',
    acrossTail === 'あい漢字' || acrossTail === 'い漢字',
    JSON.stringify(acrossTail),
  )
  check('no replacement or half glyph in wide copies', !/[�]/.test(acrossHead + acrossTail))
}

check(
  'selection operations never mutate screen cells',
  screenLines(frame.screen).join('\n') === before,
)

{
  const s = createSelectionState()
  startSelection(s, 5, 0)
  updateSelection(s, 5, 0)
  finishSelection(s)
  check('bare click (no drag) selects nothing', getSelectedText(s, frame.screen) === '', getSelectedText(s, frame.screen))
}

if (failures > 0) {
  console.log(`\nbedrock selection copy: RED (${failures} failure${failures === 1 ? '' : 's'})`)
  process.exit(1)
}
console.log('\nbedrock selection copy: green')
