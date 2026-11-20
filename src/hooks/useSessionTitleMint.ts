import { useSubscription } from './effects.js'
import { startSessionTitleMintWatch } from '../services/concourse/sessionTitleMint.js'

export function useSessionTitleMint(): void {
  useSubscription(() => {
    const handle = startSessionTitleMintWatch()
    return () => handle.dispose()
  }, [])
}
