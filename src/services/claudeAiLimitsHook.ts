import { useEffect, useState } from 'react'

import { currentLimits, statusListeners, type ClaudeAILimits } from './claudeAiLimits.js'

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
