import { useState } from 'react'
import { useSubscription } from '../hooks/effects.js'

import { currentLimits, statusListeners, type AnthropicLimits } from './anthropicLimits.js'

export function useAnthropicLimits(): AnthropicLimits {
  const [limits, setLimits] = useState<AnthropicLimits>({ ...currentLimits })
  useSubscription(() => {
    const listener = (next: AnthropicLimits): void => {
      setLimits({ ...next })
    }
    statusListeners.add(listener)
    return () => {
      statusListeners.delete(listener)
    }
  }, [])
  return limits
}
