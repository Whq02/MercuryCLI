import React from 'react'
import { useInput } from '../../../screen/themedRenderer.js'

export function SuccessEnterConfirms({ onDone }: { onDone: () => void }): React.ReactNode {
  useInput((input, key) => {
    if (key.return || key.escape) onDone()
  })
  return null
}

export function ErrorEnterRetries({
  hasRetry,
  onRetry,
}: {
  hasRetry: boolean
  onRetry: () => void
}): React.ReactNode {
  useInput((input, key) => {
    if (key.return && hasRetry) onRetry()
  })
  return null
}
