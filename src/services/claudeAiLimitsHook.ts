import { useEffect, useState } from 'react'

import { currentLimits, statusListeners, type ClaudeAILimits } from './claudeAiLimits.js'

/**
 * Mirrors the limits singleton into component state. The initial state is
 * a copy of the current singleton, so a component mounting after a change
 * still shows the truth.
 */
export function useClaudeAiLimits(): ClaudeAILimits {
  const [limits, setLimits] = useState<ClaudeAILimits>({ ...currentLimits })
  useEffect(() => {
    const listener = (next: ClaudeAILimits): void => {
      setLimits({ ...next })
    }
    statusListeners.add(listener)
    return () => {
      statusListeners.delete(listener)
    }
  }, [])
  return limits
}
