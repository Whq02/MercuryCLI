import { useEffect, useRef, useState } from 'react'
import { stableSelectionFallback } from '../contracts.js'
import type { ScreenProps } from './state.js'

export function useConcourseRail({ snapshot, presentationCapsule }: Pick<ScreenProps, 'snapshot' | 'presentationCapsule'>) {
  const [railSel, setRailSel] = useState<string | null>(
    () => presentationCapsule?.railSel ?? snapshot.needsYou[0]?.obligationId ?? null,
  )
  const railSelRef = useRef<string | null>(railSel)
  railSelRef.current = railSel
  const railLastIdxRef = useRef(0)
  useEffect(() => {
    const fb = stableSelectionFallback(
      snapshot.needsYou.map(o => o.obligationId),
      railSel,
      railLastIdxRef.current,
    )
    railLastIdxRef.current = fb.index
    if (fb.sessionId !== railSel) setRailSel(fb.sessionId)
  }, [snapshot.needsYou, railSel])
  const railIndex = Math.max(0, snapshot.needsYou.findIndex(o => o.obligationId === railSel))
  return { railSel, setRailSel, railSelRef, railIndex }
}
