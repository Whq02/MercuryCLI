import { useEffect } from 'react'
import { fluxMark } from '../utils/flux/fluxProbe.js'

export function useFluxMountMark(kind: string): void {
  useEffect(() => {
    fluxMark(`mount:${kind}`)
    return () => fluxMark(`unmount:${kind}`)
  }, [kind])
}
