// Declares where the physical terminal cursor should be parked after each
// frame. Returns a ref callback for the box containing the input; the
// declared line/column are read relative to that box's rendered rectangle.
//
// Why this exists: terminal emulators render IME pre-edit text at the
// physical cursor, and screen readers and magnifiers track the native
// cursor — parking it at the text caret makes CJK composition appear
// inline and lets accessibility tools follow the input.
//
// Timing: both the ref attachment and the declaration effect run in the
// layout phase, after the renderer schedules a frame but before the frame
// is produced (production is deferred by a microtask) — so a declaration
// takes effect on the FIRST frame, with no one-keystroke lag. Test
// environments produce frames synchronously with no microtask; tests must
// trigger a render explicitly after rendering.

import { useCallback, useContext, useLayoutEffect, useRef } from 'react'
import CursorDeclarationContext from '../components/CursorDeclarationContext.js'
import type { DOMElement } from '../dom.js'

export function useDeclaredCursor({
  line,
  column,
  active,
}: {
  line: number
  column: number
  active: boolean
}): (el: DOMElement | null) => void {
  const setDeclaration = useContext(CursorDeclarationContext)
  const nodeRef = useRef<DOMElement | null>(null)

  const ref = useCallback((el: DOMElement | null) => {
    nodeRef.current = el
  }, [])

  // Runs on EVERY commit — deliberately no dependency list: the active
  // instance must re-claim the declaration after another instance's
  // unmount-cleanup or a sibling focus handoff nulls it. Equally
  // deliberately no cleanup function here — a cleanup on this effect would
  // transiently null the declaration between commits on every line/column
  // change.
  useLayoutEffect(() => {
    const node = nodeRef.current
    if (active && node) {
      setDeclaration({ relativeX: column, relativeY: line, node })
    } else {
      // Identity-carrying clear: the declaration owner clears only when
      // THIS node holds the declaration, so the identity test lives with
      // the owner, not here. Two hazards demand it: a memoised component
      // holding the live declaration can sit a commit out entirely, and an
      // unrelated inactive instance re-rendering in that commit must not
      // wipe a declaration its owner never gets to restate; and sibling
      // effects run in tree order, so when focus travels against that
      // order the loser's effect fires after the winner's — an
      // unconditional clear from the loser would erase what the winner
      // just declared. The node can be null (never attached); the owner
      // decides what that means.
      setDeclaration(null, node)
    }
  })

  // Unmount cleanup is a SEPARATE effect with an empty dependency list so
  // it fires exactly once, and the clear still carries this component's
  // node — unmounting an inactive instance leaves a sibling's declaration
  // alone, while unmounting the active owner does clear it.
  useLayoutEffect(() => {
    return () => {
      setDeclaration(null, nodeRef.current)
    }
  }, [])

  return ref
}
