import { useEffect } from 'react'
import { startSessionTitleMintWatch } from '../services/concourse/sessionTitleMint.js'

export function useSessionTitleMint(): void {
  useEffect(() => {
    const handle = startSessionTitleMintWatch()
    return () => handle.dispose()
  }, [])
}
