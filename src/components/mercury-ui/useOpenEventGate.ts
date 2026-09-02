import { useState } from 'react'
import { currentInputEventSeq } from '../../ink/events/input-event.js'

export function useOpenEventGate(): () => boolean {
  const [openSeq] = useState(() => currentInputEventSeq())
  return () => currentInputEventSeq() > openSeq
}
