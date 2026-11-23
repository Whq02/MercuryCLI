import { useClaim } from '../effects/effects.js'
import { startSessionTitleMintWatch } from '../concourse-model/sessionTitleMint.js'

export function useSessionTitleMint(): void {
  useClaim(() => {
    const handle = startSessionTitleMintWatch()
    return () => handle.dispose()
  }, [])
}
