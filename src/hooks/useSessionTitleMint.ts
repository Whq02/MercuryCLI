import { useClaim } from './effects.js'
import { startSessionTitleMintWatch } from '../services/concourse/sessionTitleMint.js'

export function useSessionTitleMint(): void {
  useClaim(() => {
    const handle = startSessionTitleMintWatch()
    return () => handle.dispose()
  }, [])
}
