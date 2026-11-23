import { useRef, useState, useSyncExternalStore } from 'react';
import { useLayoutClaim, useLayoutPublish } from '../hooks/effects.js';
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

export function useRegisterOverlay(
  id: string,
  enabled = true,
  opts?: { onFocusReturn?: () => void; ownsPageKeys?: boolean },
): number | null {
  const [token] = useState(reserveOverlayToken);
  const onFocusReturnRef = useRef(opts?.onFocusReturn);
  onFocusReturnRef.current = opts?.onFocusReturn;
  const ownsPageKeys = opts?.ownsPageKeys;
  const ownsPageKeysRef = useRef(ownsPageKeys);
  ownsPageKeysRef.current = ownsPageKeys;

  useLayoutClaim(() => {
    if (!enabled) return;
    pushOverlay({
      id,
      modal: id !== 'autocomplete',
      token,
      onFocusReturn: () => onFocusReturnRef.current?.(),
      ownsPageKeys: ownsPageKeysRef.current,
    });
    return () => {
      popOverlay(token);
      instances.get(process.stdout)?.invalidatePrevFrame();
    };
  }, [id, enabled, token]);

  useLayoutPublish(() => {
    if (!enabled) return;
    setOverlayPageKeys(token, ownsPageKeys);
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
