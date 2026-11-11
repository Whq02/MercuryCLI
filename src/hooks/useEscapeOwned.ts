import { useLayoutEffect, useSyncExternalStore } from 'react'
import { useIsOverlayActive } from '../context/overlayContext.js'

const holders = new Set<symbol>()
const listeners = new Set<() => void>()
let version = 0

function moved(): void {
  version++
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const holdersVersion = (): number => version

export function useHoldsEscape(holds: boolean): void {
  useLayoutEffect(() => {
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
  useSyncExternalStore(subscribe, holdersVersion, holdersVersion)
  return overlayHolds || holders.size > 0
}
