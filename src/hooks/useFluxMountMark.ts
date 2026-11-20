import { useClaim } from './effects.js'
import { fluxMark } from '../utils/flux/fluxProbe.js'

export function useFluxMountMark(kind: string): void {
  useClaim(() => {
    fluxMark(`mount:${kind}`)
    return () => fluxMark(`unmount:${kind}`)
  }, [kind])
}
