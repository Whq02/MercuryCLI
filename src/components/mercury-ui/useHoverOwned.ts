import { useEffect, useSyncExternalStore } from 'react'
import { flagEnv } from '../../substrate/flagRegistry.js'
import {
  getHoverOwner,
  subscribeHover,
} from '../../utils/cockpit/hoverOwner.js'

export function useHoverOwned(id: string): boolean {
  const owned = useSyncExternalStore(
    subscribeHover,
    () => getHoverOwner() === id,
    () => false,
  )
  useEffect(() => {
    const p = flagEnv('MERCURY_HOVER_DEBUG')
    if (!p) return
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      ;(require('node:fs') as typeof import('node:fs')).appendFileSync(
        p,
        JSON.stringify({ ev: 'commit', id, owned }) + '\n',
      )
    } catch {
    }
  }, [owned, id])
  return owned
}

export function useHoverOwner(): string | null {
  return useSyncExternalStore(subscribeHover, getHoverOwner, () => null)
}

export { claimHover, releaseHover } from '../../utils/cockpit/hoverOwner.js'
