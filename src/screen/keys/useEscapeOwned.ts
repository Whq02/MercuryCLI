import { useSyncExternalStore } from 'react'
import { useLayoutClaim } from '../effects/effects.js'
import { useIsOverlayActive } from '../overlays/overlayHooks.js'
import { createSignal } from '../../platform/async/signal.js'

const holders = new Set<symbol>()
const listeners = createSignal()
let version = 0

function moved(): void {
  version++
  listeners.emit()
}

const holdersVersion = (): number => version

export function useHoldsEscape(holds: boolean): void {
  useLayoutClaim(() => {
    if (!holds) return
    const hold = Symbol('escape')
    holders.add(hold)
    moved()
    return () => {
      holders.delete(hold)
      moved()
    }
  }, [holds])
}

export function useEscapeOwned(): boolean {
  const overlayHolds = useIsOverlayActive()
  useSyncExternalStore(listeners.subscribe, holdersVersion, holdersVersion)
  return overlayHolds || holders.size > 0
}
