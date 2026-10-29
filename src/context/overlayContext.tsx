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
  setOverlayPageKeys,
  subscribeOverlayStack,
} from './overlayStack.js';

export { isTopOverlayNow } from './overlayStack.js';

const NON_MODAL_OVERLAYS = new Set(['autocomplete']);

export function useRegisterOverlay(
  id: string,
  t0?: boolean,
  opts?: { onFocusReturn?: () => void; ownsPageKeys?: boolean },
): number | null {
  const enabled = t0 === undefined ? true : t0;

  const [token] = useState(() => reserveOverlayToken());

  const focusReturnRef = useRef(opts?.onFocusReturn);
  focusReturnRef.current = opts?.onFocusReturn;

  const ownsPageKeysRef = useRef(opts?.ownsPageKeys);
  ownsPageKeysRef.current = opts?.ownsPageKeys;

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

      instances.get(process.stdout)?.invalidatePrevFrame();
    };
  }, [id, enabled, token]);
  const ownsPageKeys = opts?.ownsPageKeys;
  useLayoutEffect(() => {
    if (enabled) setOverlayPageKeys(token, ownsPageKeys);
  }, [enabled, token, ownsPageKeys]);

  return enabled ? token : null;
}

export function useIsOverlayActive(): boolean {
  useSyncExternalStore(subscribeOverlayStack, overlayStackVersion, overlayStackVersion);
  return anyOverlayActive();
}

export function useIsModalOverlayActive(): boolean {
  useSyncExternalStore(subscribeOverlayStack, overlayStackVersion, overlayStackVersion);
  return anyModalOverlayActive();
}

export function useOverlayOpen(id: string): boolean {
  useSyncExternalStore(subscribeOverlayStack, overlayStackVersion, overlayStackVersion);
  return overlayStackSnapshot().some(entry => entry.id === id);
}
