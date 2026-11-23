import { useMemo } from 'react'
import { usePublish } from '../../effects/effects.js'
import type { ConcourseRegion } from '../ConcourseLayout.js'
import { collapseSplitForFrame, splitAvailableAt } from '../splitView.js'
import type { Draft, Frame, Geometry, Panes, ScreenProps, Selection } from './state.js'

export function useConcourseRegions({ snapshot, reducedStage, compact, geo, olderList, region, setNote, setOlderList, setRegion, splitActive, termCols, termRows }: Pick<ScreenProps, 'snapshot' | 'reducedStage'> & Pick<Frame, 'compact' | 'splitActive' | 'termCols' | 'termRows'> & Pick<Geometry, 'geo'> & Pick<Selection, 'olderList' | 'setOlderList'> & Pick<Panes, 'region' | 'setRegion'> & Pick<Draft, 'setNote'>) {
  const regionsInOrder = useMemo<ConcourseRegion[]>(() => {
    const ring: ConcourseRegion[] = compact || reducedStage ? ['list', 'live'] : ['live', 'list']
    if (!compact && snapshot.needsYou.length > 0) ring.push('rail')
    if (splitActive) ring.push('chat')
    return ring
  }, [snapshot.needsYou.length, reducedStage, splitActive, compact])
  let nextRegion = region
  if (region === 'rail' && snapshot.needsYou.length === 0) nextRegion = 'list'
  if (compact && region !== 'list' && region !== 'live') nextRegion = 'list'
  if (!splitActive && region === 'chat') nextRegion = reducedStage ? 'list' : 'live'
  if (nextRegion !== region) setRegion(nextRegion)
  usePublish(() => {
    if (reducedStage) return
    const c = collapseSplitForFrame(termCols, termRows)
    if (c.collapsed) setNote({ tone: 'warning', text: c.line })
    else if (splitAvailableAt(termCols, termRows)) {
      setNote(prev => (prev !== null && prev.text.startsWith('split collapsed') ? null : prev))
    }
  }, [termCols, termRows, reducedStage])
  if (olderList !== null && geo.peekRows < 2) {
    setOlderList(null)
    setNote({ tone: 'muted', text: 'older chats folded — no room at this height' })
  }
  return { regionsInOrder }
}
