// ============================================================================
//  cursor-park.ts — T6: the cursor plan as a PURE
//  function.
//
//  Two responsibilities that would otherwise be ~110 mutating lines inside onRender:
//
//  1. THE ALT SANDWICH — every non-empty alt frame is bracketed: CSI H first
//     (the frame writer's relative moves compute from a known spot —
//     self-healing against out-of-band cursor drift; ERASE+HOME once when a
//     resize/exit-editor consumed the deferred-erase arm, atomic inside
//     BSU/ESU) and a park CUP rows;1 last (iTerm2's cursor guide tracks the
//     cursor independently of content — parking at the prompt row stops the
//     guide chasing the last-written cell every frame). Empty diff ⇒ neither
//     (the zero-write fast path stays zero-write).
//
//  2. DECLARED-CURSOR PARKING — a component (useDeclaredCursor) declares
//     where the physical cursor belongs (IME preedit renders at the physical
//     cursor; screen readers track it). Main-screen: the frame writer's
//     relative moves assume the cursor sits at prevFrame.cursor, so a parked
//     cursor needs a PREAMBLE move back before the diff bytes, and the
//     declared target is reached with a relative move after; a cleared
//     declaration restores frame.cursor before the park is forgotten
//     (otherwise nextParked=null lies and the NEXT frame's moves compute
//     from a wrong spot). Alt-screen: one absolute CUP appended after the
//     park patch — the declared position wins; next frame's CSI H resets.
//
//  Pure: (state in) → {prelude, postlude, nextParked, consumedErase} — the
//  pipeline splices `[...prelude, ...diff, ...postlude]` and settles
//  displayCursor/needsErase from the plan. LAW DISPLAY-CURSOR +
//  LAW ALT-SANDWICH drive this function end-to-end through real frames;
//  the unit legs drive it directly.
// ============================================================================
import type { Patch } from '../frame.js'
import { CURSOR_HOME, cursorMove, cursorPosition, ERASE_SCREEN } from '../termio/csi.js'

export type CursorPoint = { x: number; y: number }

export type CursorPlanInput = {
  altScreen: boolean
  /** optimized.length > 0 — the frame has bytes to write. */
  hasDiff: boolean
  /** One-shot deferred-erase arm (resize / editor return). The plan reports
   *  consumption; the caller clears the arm. */
  needsErase: boolean
  /** The frozen park patch (CUP rows;1) — cached per instance, rebuilt on
   *  resize. */
  parkPatch: Patch
  /** The declared target in absolute screen cells, already resolved through
   *  nodeCache — null when no declaration is active (or the node didn't
   *  render this frame: stale after remount, scrolled out of view). */
  target: CursorPoint | null
  /** Where the previous plan parked the physical cursor (displayCursor) —
   *  null when the cursor sits wherever the frame writer left it. */
  parked: CursorPoint | null
  /** prevFrame.cursor — the writer's relative-move anchor. */
  prevCursor: CursorPoint
  /** frame.cursor — where the writer leaves the cursor after this diff. */
  frameCursor: CursorPoint
  rows: number
  cols: number
}

export type CursorPlan = {
  /** Splice BEFORE the diff bytes. */
  prelude: Patch[]
  /** Splice AFTER the diff bytes. */
  postlude: Patch[]
  /** The next displayCursor. */
  nextParked: CursorPoint | null
  /** The one-shot erase arm was consumed — caller clears it. */
  consumedErase: boolean
}

const CURSOR_HOME_PATCH: Patch = Object.freeze({ type: 'stdout' as const, content: CURSOR_HOME })
const ERASE_THEN_HOME_PATCH: Patch = Object.freeze({
  type: 'stdout' as const,
  content: ERASE_SCREEN + CURSOR_HOME,
})

export function planCursor(input: CursorPlanInput): CursorPlan {
  const { altScreen, hasDiff, target, parked, prevCursor, frameCursor, rows, cols } = input
  const prelude: Patch[] = []
  const postlude: Patch[] = []
  let consumedErase = false

  // 1. The alt sandwich — non-empty frames only.
  if (altScreen && hasDiff) {
    if (input.needsErase) {
      consumedErase = true
      prelude.push(ERASE_THEN_HOME_PATCH)
    } else {
      prelude.push(CURSOR_HOME_PATCH)
    }
    postlude.push(input.parkPatch)
  }

  // 2. Declared-cursor parking. The empty-diff zero-write fast path: skip
  //    every cursor write when nothing rendered AND the park target is
  //    unchanged (and no cleared-while-parked restore is owed).
  const targetMoved =
    target !== null && (parked === null || parked.x !== target.x || parked.y !== target.y)
  if (!hasDiff && !targetMoved && !(target === null && parked !== null)) {
    return { prelude, postlude, nextParked: parked, consumedErase }
  }

  // Main-screen preamble: the writer's relative moves assume the cursor is
  // at prevCursor; a parked cursor moves back BEFORE the diff runs.
  // Alt-screen's CSI H already reset to (0,0).
  if (parked !== null && !altScreen && hasDiff) {
    const pdx = prevCursor.x - parked.x
    const pdy = prevCursor.y - parked.y
    if (pdx !== 0 || pdy !== 0) {
      prelude.unshift({ type: 'stdout', content: cursorMove(pdx, pdy) })
    }
  }

  if (target !== null) {
    if (altScreen) {
      // Absolute CUP (1-indexed), after the park patch — declared wins;
      // next frame's CSI H resets regardless.
      const row = Math.min(Math.max(target.y + 1, 1), rows)
      const col = Math.min(Math.max(target.x + 1, 1), cols)
      postlude.push({ type: 'stdout', content: cursorPosition(row, col) })
    } else {
      // After the diff (or preamble) the cursor is at frameCursor; with no
      // diff and a previous park it never moved — still at the old park.
      const from = !hasDiff && parked !== null ? parked : frameCursor
      const dx = target.x - from.x
      const dy = target.y - from.y
      if (dx !== 0 || dy !== 0) {
        postlude.push({ type: 'stdout', content: cursorMove(dx, dy) })
      }
    }
    return { prelude, postlude, nextParked: target, consumedErase }
  }

  // Declaration cleared (blur/unmount): restore the physical cursor to
  // frameCursor before forgetting the park — nextParked=null must not lie.
  // The preamble above already handled the hasDiff case.
  if (parked !== null && !altScreen && !hasDiff) {
    const rdx = frameCursor.x - parked.x
    const rdy = frameCursor.y - parked.y
    if (rdx !== 0 || rdy !== 0) {
      postlude.push({ type: 'stdout', content: cursorMove(rdx, rdy) })
    }
  }
  return { prelude, postlude, nextParked: null, consumedErase }
}
