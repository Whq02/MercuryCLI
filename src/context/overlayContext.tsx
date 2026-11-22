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
import { notBuilt } from '../pi/holes.js'

export { isTopOverlayNow } from './overlayStack.js';

export function useRegisterOverlay(
  id: string,
  t0?: boolean,
  opts?: { onFocusReturn?: () => void; ownsPageKeys?: boolean },
): number | null {
  return notBuilt('src/context/overlayContext.tsx:20')
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
