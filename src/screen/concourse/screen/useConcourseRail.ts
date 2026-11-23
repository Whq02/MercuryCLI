import { useRef, useState } from 'react'
import { stableSelectionFallback } from '../contracts.js'
import type { ScreenProps } from './state.js'

export function useConcourseRail({ snapshot, presentationCapsule }: Pick<ScreenProps, 'snapshot' | 'presentationCapsule'>) {
  const [rawRailSel, setRailSel] = useState<string | null>(
    () => presentationCapsule?.railSel ?? snapshot.needsYou[0]?.obligationId ?? null,
  )
  const [railLastIdx, setRailLastIdx] = useState(0)
  const fb = stableSelectionFallback(
    snapshot.needsYou.map(o => o.obligationId),
    rawRailSel,
    railLastIdx,
  )
  const railSel = fb.sessionId
  if (railSel !== rawRailSel) setRailSel(railSel)
  if (fb.index !== railLastIdx) setRailLastIdx(fb.index)
  const railSelRef = useRef<string | null>(railSel)
  railSelRef.current = railSel
  const railIndex = Math.max(0, snapshot.needsYou.findIndex(o => o.obligationId === railSel))
  return { railSel, setRailSel, railSelRef, railIndex }
}
