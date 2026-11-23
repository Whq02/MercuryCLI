import { useClaim } from '../effects/effects.js'
import { fluxMark } from '../../integrations/media-flux/fluxProbe.js'

export function useFluxMountMark(kind: string): void {
  useClaim(() => {
    fluxMark(`mount:${kind}`)
    return () => fluxMark(`unmount:${kind}`)
  }, [kind])
}
