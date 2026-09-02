// mercury-ui/useHoverOwned — the React face of the single-owner hover store
// (utils/cockpit/hoverOwner.ts, an import-free leaf the ink mouse decode
// taps). A hoverable element subscribes with a stable id (React.useId() is
// the right source — unique per instance, stable across re-renders); exactly
// one id is hovered at a time, and none while the pointer is down. Adopt this
// instead of a local `useState` + enter/leave pair — the pair strands
// highlights on missed leaves.
//
// PERF CONTRACT: the snapshot is the per-id BOOLEAN, so React bails out for
// every row whose answer didn't change — a hover edge re-renders exactly the
// old owner and the new owner, matching the local-useState render traffic
// (the REPL render-traffic ratchet stays untouched).
import { useEffect, useSyncExternalStore } from 'react'
import { flagEnv } from '../../substrate/flagRegistry.js'
import {
  getHoverOwner,
  subscribeHover,
} from '../../utils/cockpit/hoverOwner.js'

export function useHoverOwned(id: string): boolean {
  const owned = useSyncExternalStore(
    subscribeHover,
    () => getHoverOwner() === id,
    () => false,
  )
  // Diagnostics seam (MERCURY_HOVER_DEBUG=<path>): logs each COMMITTED
  // ownership transition — how the E2E proof separates a React bail-out from
  // a screen-diff stale paint. Zero cost when unset.
  useEffect(() => {
    const p = flagEnv('MERCURY_HOVER_DEBUG')
    if (!p) return
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      ;(require('node:fs') as typeof import('node:fs')).appendFileSync(
        p,
        JSON.stringify({ ev: 'commit', id, owned }) + '\n',
      )
    } catch {
      /* diagnostics never break the row */
    }
  }, [owned, id])
  return owned
}

/** Parent-level consumers (a hint slot previewing WHICH child is hovered)
 *  read the raw owner and match their own prefix. Re-renders on every hover
 *  edge — reserve for small parents that already tracked hover state. */
export function useHoverOwner(): string | null {
  return useSyncExternalStore(subscribeHover, getHoverOwner, () => null)
}

export { claimHover, releaseHover } from '../../utils/cockpit/hoverOwner.js'
