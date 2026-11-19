import { useMemo, useRef, useState } from 'react'
import type { ConcourseRowV1 } from '../contracts.js'
import type { LineDraft } from '../lineDraft.js'
import { newSessionLineShown } from '../ConcourseLayout.js'
import type { Frame, ScreenProps } from './state.js'

export function useConcourseFilter({ snapshot, callbacks, reducedStage, presentationCapsule, compact }: Pick<ScreenProps, 'snapshot' | 'callbacks' | 'reducedStage' | 'presentationCapsule'> & Pick<Frame, 'compact'>) {
  const [filtering, setFiltering] = useState(presentationCapsule?.filtering ?? false)
  const [filter, setFilter] = useState<LineDraft>(presentationCapsule?.filter ?? { text: '', caret: 0 })
  const filterRef = useRef(filter)
  filterRef.current = filter
  const editFilter = (op: (d: LineDraft) => LineDraft): void => setFilter(prev => op(prev))
  const boardGroups = useMemo(() => {
    const q = filter.text.trim().toLowerCase()
    if (q.length === 0) return snapshot.groups
    return snapshot.groups
      .map(g => ({
        ...g,
        rows: g.rows.filter(
          r => r.title.toLowerCase().includes(q) || r.projectLabel.toLowerCase().includes(q),
        ),
      }))
      .filter(g => g.rows.length > 0)
  }, [snapshot.groups, filter.text])
  const sessionRows: ConcourseRowV1[] = useMemo(() => boardGroups.flatMap(g => g.rows), [boardGroups])
  const newSessionLine = newSessionLineShown({ newSession: !compact && !reducedStage && callbacks.newSession !== undefined, sessionRows: sessionRows.length, filterText: filter.text })
  const newSessionLineNow = (): boolean =>
    newSessionLineShown({ newSession: !compact && !reducedStage && callbacks.newSession !== undefined, sessionRows: sessionRows.length, filterText: filterRef.current.text })
  return { filtering, setFiltering, filter, setFilter, filterRef, editFilter, boardGroups, sessionRows, newSessionLine, newSessionLineNow }
}
