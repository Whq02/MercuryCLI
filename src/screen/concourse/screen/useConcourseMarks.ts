import { useMemo, useRef, useState } from 'react'
import { useTimer } from '../../effects/effects.js'
import type { ConcourseRowV1 } from '../contracts.js'
import { OLDER_CHATS_ROW_PREFIX } from '../../concourse-model/concourseSnapshot.js'
import { COMPACT_DOOR_NOTE_MS } from '../compactBoard.js'
import { consumeSignInPickerReturn } from './signInPicker.js'
import type { Filter, Panes, ScreenProps, Selection } from './state.js'
import { startTimeout, stopTimeout } from '../../../platform/async/timers.js'

export function useConcourseMarks({ snapshot, boardSel, olderList, region, sessionRows, setOlderList }: Pick<ScreenProps, 'snapshot'> & Pick<Selection, 'boardSel' | 'olderList' | 'setOlderList'> & Pick<Panes, 'region'> & Pick<Filter, 'sessionRows'>) {
  if (olderList !== null && (boardSel === null || !boardSel.startsWith(OLDER_CHATS_ROW_PREFIX))) {
    setOlderList(null)
  }
  const [rawBoardArmed, setBoardArmed] = useState<string | null>(null)
  const boardArmed = rawBoardArmed !== null && boardSel !== rawBoardArmed ? null : rawBoardArmed
  if (boardArmed !== rawBoardArmed) setBoardArmed(null)
  const boardArmedRef = useRef<string | null>(null)
  boardArmedRef.current = boardArmed
  const [doorNoteSeq, setDoorNoteSeq] = useState(0)
  const [doorCtx, setDoorCtx] = useState({ boardSel, region })
  let currentDoorSeq = doorNoteSeq
  if (doorCtx.boardSel !== boardSel || doorCtx.region !== region) {
    setDoorCtx({ boardSel, region })
    if (doorNoteSeq !== 0) {
      setDoorNoteSeq(0)
      currentDoorSeq = 0
    }
  }
  const doorNote = currentDoorSeq > 0
  const doorNoteRef = useRef(false)
  doorNoteRef.current = doorNote
  const clearDoorNote = (): void => {
    if (doorNoteRef.current) {
      doorNoteRef.current = false
      setDoorNoteSeq(0)
    }
  }
  const showDoorNote = (): void => {
    doorNoteRef.current = true
    setDoorNoteSeq(seq => seq + 1)
  }
  useTimer(() => {
    if (doorNoteSeq === 0) return
    const timer = startTimeout(() => {
      doorNoteRef.current = false
      setDoorNoteSeq(0)
    }, COMPACT_DOOR_NOTE_MS)
    timer.unref?.()
    return () => stopTimeout(timer)
  }, [doorNoteSeq])
  const [rawMarkedIds, setMarkedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [markProject, setMarkProject] = useState(snapshot.context.projectLabel)
  let markedIds = rawMarkedIds
  if (markProject !== snapshot.context.projectLabel) {
    setMarkProject(snapshot.context.projectLabel)
    if (rawMarkedIds.size > 0) {
      const empty = new Set<string>()
      setMarkedIds(empty)
      markedIds = empty
    }
  }
  const markedIdsRef = useRef<ReadonlySet<string>>(markedIds)
  markedIdsRef.current = markedIds
  const markedRows = useMemo(() => sessionRows.filter(r => markedIds.has(r.sessionId)), [sessionRows, markedIds])
  const markedRowsOf = (): ConcourseRowV1[] => sessionRows.filter(r => markedIdsRef.current.has(r.sessionId))
  const toggleMark = (sessionId: string): void => {
    setMarkedIds(prev => {
      const next = new Set(prev)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }
  const [signInPicker] = useState(() => consumeSignInPickerReturn())
  const [rowPick, setRowPick] = useState<{ kind: 'model' | 'effort'; sessionId: string; title: string } | null>(
    signInPicker?.kind === 'session' ? { kind: 'model', sessionId: signInPicker.sessionId, title: signInPicker.title } : null,
  )
  const rowPickRef = useRef<{ kind: 'model' | 'effort'; sessionId: string; title: string } | null>(null)
  const [modelDefaultOpen, setModelDefaultOpen] = useState(signInPicker?.kind === 'default')
  const modelDefaultOpenRef = useRef(false)
  modelDefaultOpenRef.current = modelDefaultOpen
  rowPickRef.current = rowPick
  return { boardArmed, setBoardArmed, boardArmedRef, doorNote, doorNoteRef, clearDoorNote, showDoorNote, markedIds, setMarkedIds, markedIdsRef, markedRows, markedRowsOf, toggleMark, rowPick, setRowPick, rowPickRef, modelDefaultOpen, setModelDefaultOpen, modelDefaultOpenRef }
}
