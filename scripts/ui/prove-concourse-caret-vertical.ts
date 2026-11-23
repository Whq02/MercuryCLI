#!/usr/bin/env bun


let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  RED ${name} — ${detail ? `${detail} — ` : ''}fix caretVerticalOp in src/screen/concourse/lineDraft.ts so this case holds`)
  }
}
const NL = String.fromCharCode(10)
const UP = { upArrow: true, downArrow: false }
const DOWN = { upArrow: false, downArrow: true }

console.log('§1 caretVerticalOp — null on a single line, line-walk on a multiline draft')
{
  const { caretVerticalOp } = await import('../../src/screen/concourse/lineDraft.ts')
  check('a single-line draft yields null for ↑ and ↓ (the surface keeps its own meaning)', caretVerticalOp(UP, { text: 'one line', caret: 3 }) === null && caretVerticalOp(DOWN, { text: 'one line', caret: 3 }) === null)
  check('a non-arrow key yields null', caretVerticalOp({ upArrow: false, downArrow: false }, { text: `a${NL}b`, caret: 0 }) === null)
  const two = { text: `first line${NL}second`, caret: 4 }
  const down = caretVerticalOp(DOWN, two)
  check('↓ on line 1 moves to the same column of line 2', down !== null && down(two).caret === 'first line'.length + 1 + 4)
  const atEnd = { text: `first line${NL}ab`, caret: 8 }
  const clamp = caretVerticalOp(DOWN, atEnd)
  check('the column clamps to the shorter target line', clamp !== null && clamp(atEnd).caret === 'first line'.length + 1 + 2)
  const back = { text: `first line${NL}second`, caret: 'first line'.length + 1 + 3 }
  const up = caretVerticalOp(UP, back)
  check('↑ on line 2 returns to the same column of line 1', up !== null && up(back).caret === 3)
  check('↑ on the first line and ↓ on the last yield null (no line to reach — the key falls through unchanged)', caretVerticalOp(UP, two) === null && caretVerticalOp(DOWN, back) === null)
  check('the op reads the LATEST draft at apply time (functional update — a burst of motions each step from the newest caret)', down !== null && down({ text: `first line${NL}second`, caret: 1 }).caret === 'first line'.length + 1 + 1)
}


process.exit(failures === 0 ? 0 : 1)
