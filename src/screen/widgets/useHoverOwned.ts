import { useSyncExternalStore } from 'react'
import { usePublish } from '../effects/effects.js'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import {
  getHoverOwner,
  subscribeHover,
} from '../cockpit/hoverOwner.js'
import { passedOver } from '../../platform/errors/passedOver.js'

export function useHoverOwned(id: string): boolean {
  const owned = useSyncExternalStore(
    subscribeHover,
    () => getHoverOwner() === id,
    () => false,
  )
  usePublish(() => {
    const p = flagEnv('MERCURY_HOVER_DEBUG')
    if (!p) return
    try {
      ;(require('node:fs') as typeof import('node:fs')).appendFileSync(
        p,
        JSON.stringify({ ev: 'commit', id, owned }) + '\n',
      )
    } catch (error) {
      passedOver(error)
    }
  }, [owned, id])
  return owned
}

export function useHoverOwner(): string | null {
  return useSyncExternalStore(subscribeHover, getHoverOwner, () => null)
}

export { claimHover, releaseHover } from '../cockpit/hoverOwner.js'
