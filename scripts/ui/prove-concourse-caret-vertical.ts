#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-concourse-caret-vertical.ts
// IA-7's vertical caret motion is WIRED again (the sibling
//  of the arrow-focus law): caretVerticalOp (lineDraft.ts) — ↑↓ move the
//  caret to the same column on the adjacent line of a MULTILINE draft, null
//  on a single line so the surface keeps its own ↑↓ meaning — was written
//  and wired for both worker composers, and the three-region
//  recomposition dropped the call while its comment kept
//  promising "a MULTILINE draft keeps caret travel". Until this fix ↑↓ on a
//  multiline draft reached nothing in either concourse composer.
//
//  §1 drives the pure op; §2 pins the wire at the ONE editing-keys block
//  (the `side` router covers the coordinator and the live composer alike).
//  The POISON is the pre-fix tree: no caller of caretVerticalOp in src.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-concourse-caret-vertical.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const NL = String.fromCharCode(10)
const UP = { upArrow: true, downArrow: false }
const DOWN = { upArrow: false, downArrow: true }

// ── §1 · the pure op ────────────────────────────────────────────────────────
console.log('§1 caretVerticalOp — null on a single line, line-walk on a multiline draft')
{
  const { caretVerticalOp } = await import('../../src/components/concourse/lineDraft.ts')
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

// ── §2 · the wire ───────────────────────────────────────────────────────────
console.log('§2 the wire — the one editing-keys block routes ↑↓ to the active composer side')
{
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  check('POISON: caretVerticalOp is imported by the screen again (the pre-fix tree had no caller)', /import \{[^}]*\bcaretVerticalOp\b[^}]*\} from '\.\/lineDraft\.js'/.test(screen))
  const blockStart = screen.indexOf("if (region === 'coordinator' || region === 'live') {\n      // Multiline drafts keep caret travel")
  const blockEnd = screen.indexOf('if (input.length > 0 && !key.ctrl && !key.meta && !key.tab) {', blockStart)
  const block = screen.slice(blockStart, blockEnd)
  check('the vertical op rides the same `side` router as the horizontal motion (both composers, one wire)', blockStart > 0 && block.includes('const motion = editorMotionOp(key)') && block.includes('const vertical = caretVerticalOp(key, side.ref.current)') && block.includes('side.edit(vertical)'))
  check('the wire consumes the key (stopImmediatePropagation before the edit) and returns', /const vertical = caretVerticalOp\(key, side\.ref\.current\)\s*\n\s*if \(vertical !== null\) \{\s*\n\s*event\.stopImmediatePropagation\(\)\s*\n\s*side\.edit\(vertical\)\s*\n\s*return/.test(block))
  check('the board-browse arm still runs BEFORE the wire (a single-line live draft browses; the op is null there anyway)', screen.indexOf("(region === 'live' && (key.upArrow || key.downArrow) && !liveDraftRef.current.text.includes(NL))") < blockStart)
  check('the wire sits inside the full-stage editing block (below the reduced-stage and chat-pane returns)', screen.indexOf('if (reducedStage) {\n      // THE REDUCED STAGE') < blockStart && screen.indexOf('TYPING REACHES ONLY THE FOCUSED PANE') < blockStart)
}
// NEEDS-REAL-BOX (the live drill): on the concourse, focus the coordinator,
// type a word, ⇧↵, type a second word, press ↑ — the caret climbs to the
// first line at the same column; ↓ returns; with a single-line draft ↑↓ do
// nothing in the coordinator and browse the board from the live panel.

process.exit(failures === 0 ? 0 : 1)
