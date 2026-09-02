/**
 * Overlay registration hooks — the React face of the overlay OWNERSHIP
 * stack.
 *
 * History: this would otherwise write a `Set<string>` into AppState, which meant
 * duplicate semantic ids collided (two mounted 'select's shared one slot —
 * the first unmount silently unregistered the survivor) and nothing knew
 * WHICH overlay was on top, so Escape had no ownership answer. The stack
 * store fixes both: every registration is an INSTANCE with a token and a
 * z-position; these hooks subscribe via useSyncExternalStore.
 *
 * Usage:
 * 1. useRegisterOverlay(id, enabled?, opts?) in any overlay component —
 *    registers on mount, unregisters exactly once on unmount, returns the
 *    instance token (pass it to isTopOverlayNow in input handlers to make
 *    Escape close ONE layer).
 * 2. useIsOverlayActive() / useIsModalOverlayActive() — reactive gates for
 *    cancel handling and TextInput focus.
 * 3. useOverlayIsTop(token) — reactive "am I the top layer" for footers.
 */
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import instances from '../ink/instances.js';
import {
  anyModalOverlayActive,
  anyOverlayActive,
  overlayStackSnapshot,
  overlayStackVersion,
  popOverlay,
  pushOverlay,
  reserveOverlayToken,
  subscribeOverlayStack,
  topOverlay,
} from './overlayStack.js';

export { isTopOverlayNow } from './overlayStack.js';

// The overlays that are not modal — TextInput keeps focus while these are up.
const NON_MODAL_OVERLAYS = new Set(['autocomplete']);

/**
 * Register a component as an active overlay for its mounted (and enabled)
 * lifetime. Returns the instance token, or null while unregistered.
 *
 * @param id - Semantic identifier ('select', 'command-palette', …). Purely
 *             for modal policy + forensics — duplicates are safe.
 * @param t0 - enabled (default true). Conditional registration, e.g. only
 *             when onCancel is provided.
 * @param opts.onFocusReturn - opener focus restore, run when this entry is
 *             popped while top (see overlayStack).
 * @param opts.ownsPageKeys - this overlay renders a real paged viewport and
 *             owns PageUp/PageDown while top (the transcript scroller yields).
 */
export function useRegisterOverlay(
  id: string,
  t0?: boolean,
  opts?: { onFocusReturn?: () => void; ownsPageKeys?: boolean },
): number | null {
  const enabled = t0 === undefined ? true : t0;
  // Token reserved at FIRST RENDER (not in the effect) so input handlers
  // and memos close over the real token immediately — an effect-assigned
  // token would read null forever in a closure captured on render one.
  const [token] = useState(() => reserveOverlayToken());
  // Keep the latest focus-return without re-registering (identity churn on
  // an inline callback must not pop/push the overlay every render).
  const focusReturnRef = useRef(opts?.onFocusReturn);
  focusReturnRef.current = opts?.onFocusReturn;
  // Page-key ownership is a static per-surface declaration — captured once
  // so the effect deps stay [id, enabled, token].
  const ownsPageKeysRef = useRef(opts?.ownsPageKeys);

  // Layout effect (not passive): the registration must land before the
  // first interactive paint so the very first post-open input event already
  // sees the overlay as owning input.
  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }
    pushOverlay({
      id,
      token,
      modal: !NON_MODAL_OVERLAYS.has(id),
      onFocusReturn: () => focusReturnRef.current?.(),
      ownsPageKeys: ownsPageKeysRef.current,
    });
    return () => {
      popOverlay(token);
      // CLOSE invalidates the previous frame (pre-stack behavior kept
      // byte-for-byte): the content under the overlay re-composes from
      // scratch so stale overlay pixels can't survive the close. Open needs
      // no invalidate — the overlay paints over whatever was there.
      instances.get(process.stdout)?.invalidatePrevFrame();
    };
  }, [id, enabled, token]);

  return enabled ? token : null;
}

/**
 * Reactive: true while any overlay is active. Used by cancel handling so
 * Escape dismisses the overlay instead of cancelling the running request.
 */
export function useIsOverlayActive(): boolean {
  useSyncExternalStore(subscribeOverlayStack, overlayStackVersion, overlayStackVersion);
  return anyOverlayActive();
}

/**
 * Reactive: true while any MODAL overlay is active (non-modal overlays like
 * autocomplete don't disable TextInput focus).
 */
export function useIsModalOverlayActive(): boolean {
  useSyncExternalStore(subscribeOverlayStack, overlayStackVersion, overlayStackVersion);
  return anyModalOverlayActive();
}

/** Reactive: true while ANY overlay with this semantic id is registered.
 *  Used by the cockpit's activity projection (HZ5) to know that a review
 *  surface is open without threading a prop from wherever it mounted. */
export function useOverlayOpen(id: string): boolean {
  useSyncExternalStore(subscribeOverlayStack, overlayStackVersion, overlayStackVersion);
  return overlayStackSnapshot().some(entry => entry.id === id);
}

/** Reactive: true while `token` is the top of the overlay stack. */
export function useOverlayIsTop(token: number | null): boolean {
  useSyncExternalStore(subscribeOverlayStack, overlayStackVersion, overlayStackVersion);
  return token !== null && topOverlay()?.token === token;
}
