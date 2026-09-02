import { flagEnv } from '../../substrate/flagRegistry.js'
// ============================================================================
//  utils/cockpit/hoverOwner — ONE hover owner for every pointer-hoverable row.
//
//  The per-row `useState` hover pattern relied on paired mouse enter/leave
//  events; a fast pointer sweep, a leave landing outside any hoverable cell,
//  or a drag drops the leave — stranding rows highlighted. Operator report
// multiple rows lit at once across DIFFERENT rail cards, and
//  rows lit while the button was down ("chain-highlight"). This store makes
//  the invariant STRUCTURAL instead of event-paired:
//
//    · at most ONE element is hovered, ever — a claim by any element
//      implicitly un-lights the previous owner (a missed leave self-heals on
//      the next claim);
//    · nothing is hovered while the pointer is DOWN — the ink mouse decode
//      (App.handleMouseEvent) reports button transitions here, so drags
//      suppress hover and a press clears a lingering highlight;
//    · a lost release self-heals via the mode-1003 no-button motion signal
//      (the same recovery the drag-selection path uses).
//
//  DELIBERATELY an import-free leaf (the pointerCell.ts pattern): the
//  vendored ink layer taps it without acquiring an edge into utils/config.
//  The React hook lives view-side in mercury-ui/useHoverOwned.ts.
// ============================================================================

// The state hangs on globalThis as a KEYED SINGLETON: the bundler can inline
// this module more than once (the Bun path-map/relative duplication hazard,
// BUILD-NOTES) — with module-level state, two copies each owned a highlight
// and the chain-highlight bug SURVIVED the store (caught by the E2E proof's
// sweep leg: claims through copy 1 could never displace copy 2's owner).
type HoverState = {
  owner: string | null
  pointerDown: boolean
  version: number
  listeners: Set<() => void>
}
const S: HoverState = ((globalThis as Record<string, unknown>).__mercuryHoverOwner ??= {
  owner: null,
  pointerDown: false,
  version: 0,
  listeners: new Set(),
}) as HoverState

// Diagnostics seam (proof-side): MERCURY_HOVER_DEBUG=<path> appends one JSONL
// event per store transition — how the E2E proof sees which claims/releases
// actually fired inside the PTY child. Zero cost when unset.
function trace(ev: string, id: string | null): void {
  const p = flagEnv('MERCURY_HOVER_DEBUG')
  if (!p) return
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ;(require('node:fs') as typeof import('node:fs')).appendFileSync(
      p,
      JSON.stringify({ ev, id, owner: S.owner, down: S.pointerDown }) + '\n',
    )
  } catch {
    /* diagnostics never break the store */
  }
}

function notify(): void {
  S.version++
  for (const l of S.listeners) l()
}

/** An element the pointer entered claims the hover. No-op while the button
 *  is down (drag) — hover paints nothing mid-drag. */
export function claimHover(id: string): void {
  if (S.pointerDown || S.owner === id) return
  S.owner = id
  trace('claim', id)
  notify()
}

/** An element the pointer left releases the hover — only if it still owns it
 *  (a stale release must never clobber a newer claim). */
export function releaseHover(id: string): void {
  if (S.owner !== id) {
    trace('release-miss', id)
    return
  }
  S.owner = null
  trace('release', id)
  notify()
}

/** The ONE mouse decode path reports button transitions. Press clears any
 *  lingering highlight and suppresses claims; release re-arms. */
export function setHoverPointerDown(down: boolean): void {
  if (S.pointerDown === down) return
  S.pointerDown = down
  if (down && S.owner !== null) {
    S.owner = null
  }
  notify()
}

export function getHoverOwner(): string | null {
  return S.owner
}

export function subscribeHover(cb: () => void): () => void {
  S.listeners.add(cb)
  return () => {
    S.listeners.delete(cb)
  }
}

/** Test seam — proofs reset the store state between cases. */
export function resetHoverOwnerForTest(): void {
  S.owner = null
  S.pointerDown = false
  S.version = 0
}
