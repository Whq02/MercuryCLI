// ============================================================================
//  useElevatedSurface — LUSTRE L1: the ONE React face of elevated-surface
//  registration. A focused overlay that genuinely sits above retained context
//  (the quick-open overlays · the bottom-slot pickers · the modal slot)
//  attaches this ref to its outermost Box; the compositor then recesses
//  every cell outside the committed rect while the surface is mounted.
//
//  Registration is STRUCTURAL (React re-calls the previous ref with null on
//  detach), so unmount/summon races can't leak a registration — and an OFF
//  gate simply never attaches the ref (the recess target is the policy
//  owner's job; a registrant without a target costs nothing).
// ============================================================================
import * as React from 'react'
import { registerElevatedSurface } from '../../ink/recessLayer.js'
import type { DOMElement } from '../../ink.js'

export function useElevatedSurface(): (el: DOMElement | null) => void {
  const unregRef = React.useRef<(() => void) | null>(null)
  return React.useCallback((el: DOMElement | null) => {
    unregRef.current?.()
    unregRef.current = el ? registerElevatedSurface(el) : null
  }, [])
}
