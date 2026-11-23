import { useSyncExternalStore } from 'react'

import { currentLimits, statusListeners, type AnthropicLimits } from '../../models/roads/anthropic/anthropicLimits.js'

function getAnthropicLimits(): AnthropicLimits {
  return currentLimits
}

function subscribeAnthropicLimits(listener: () => void): () => void {
  const wrapped = (): void => {
    listener()
  }
  statusListeners.add(wrapped)
  return () => {
    statusListeners.delete(wrapped)
  }
}

export function useAnthropicLimits(): AnthropicLimits {
  return useSyncExternalStore(subscribeAnthropicLimits, getAnthropicLimits, getAnthropicLimits)
}
