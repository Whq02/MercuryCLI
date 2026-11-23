import { useRef, useState } from 'react'
import type { ConcourseRegion } from '../ConcourseLayout.js'
import { migrateCapsuleRegion } from './capsule.js'
import type { Frame, ScreenProps } from './state.js'

export function useConcoursePanes({ reducedStage, presentationCapsule, compact }: Pick<ScreenProps, 'reducedStage' | 'presentationCapsule'> & Pick<Frame, 'compact'>) {
  const [region, setRegion] = useState<ConcourseRegion>(() => {
    const carried = migrateCapsuleRegion(presentationCapsule?.region)
    if (compact) return carried === 'live' ? 'live' : 'list'
    if (reducedStage) return 'list'
    return carried ?? 'list'
  })
  const [helpOpen, setHelpOpen] = useState(false)
  const helpOpenRef = useRef(false)
  const [groundPickerOpen, setGroundPickerOpen] = useState(false)
  const groundPickerOpenRef = useRef(false)
  groundPickerOpenRef.current = groundPickerOpen
  return { region, setRegion, helpOpen, setHelpOpen, helpOpenRef, groundPickerOpen, setGroundPickerOpen, groundPickerOpenRef }
}
