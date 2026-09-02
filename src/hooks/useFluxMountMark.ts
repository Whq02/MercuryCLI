import { useEffect } from 'react'
import { fluxMark } from '../utils/flux/fluxProbe.js'

/**
 * useFluxMountMark — probe-ring mount/unmount observation (COCKPIT
 * S1b). Emits `mount:<kind>` on mount and `unmount:<kind>` on unmount so
 * out-of-process provers can count REAL React lifecycle churn for a row
 * (remounts are invisible in the byte stream when the replacement paints
 * identical cells). Inert unless MERCURY_FLUX_PROBE is armed — fluxMark is a
 * latched-boolean check + return when disabled; zero allocation, zero
 * ordering change, zero user-visible semantics.
 */
export function useFluxMountMark(kind: string): void {
  useEffect(() => {
    fluxMark(`mount:${kind}`)
    return () => fluxMark(`unmount:${kind}`)
  }, [kind])
}
