import { useMemo, useRef, useState } from 'react'
import { useClaim, useDerivedState } from '../../../hooks/effects.js'
import type { ConcourseRowV1 } from '../contracts.js'
import { OLDER_CHATS_ROW_PREFIX } from '../../../services/concourse/concourseSnapshot.js'
import { COMPACT_DOOR_NOTE_MS } from '../compactBoard.js'
import { consumeSignInPickerReturn } from './signInPicker.js'
import type { Filter, Panes, ScreenProps, Selection } from './state.js'
import { startTimeout, stopTimeout } from '../../../utils/timers.js'

export function useConcourseMarks({ snapshot, boardSel, olderList, region, sessionRows, setOlderList }: Pick<ScreenProps, 'snapshot'> & Pick<Selection, 'boardSel' | 'olderList' | 'setOlderList'> & Pick<Panes, 'region'> & Pick<Filter, 'sessionRows'>) {
  useDerivedState(() => {
    if (olderList !== null && (boardSel === null || !boardSel.startsWith(OLDER_CHATS_ROW_PREFIX))) setOlderList(null)
  }, [boardSel, olderList])
  const [boardArmed, setBoardArmed] = useState<string | null>(null)
  const boardArmedRef = useRef<string | null>(null)
  boardArmedRef.current = boardArmed
  const [doorNote, setDoorNote] = useState(false)
  const doorNoteRef = useRef(false)
  doorNoteRef.current = doorNote
  const doorNoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearDoorNote = (): void => {
    if (doorNoteTimerRef.current !== null) {
      stopTimeout(doorNoteTimerRef.current)
      doorNoteTimerRef.current = null
    }
    if (doorNoteRef.current) {
      doorNoteRef.current = false
      setDoorNote(false)
    }
  }
  const showDoorNote = (): void => {
    clearDoorNote()
    doorNoteRef.current = true
    setDoorNote(true)
    const timer = startTimeout(() => {
      doorNoteTimerRef.current = null
      doorNoteRef.current = false
      setDoorNote(false)
    }, COMPACT_DOOR_NOTE_MS)
    timer.unref?.()
    doorNoteTimerRef.current = timer
  }
  useClaim(() => () => {
    if (doorNoteTimerRef.current !== null) stopTimeout(doorNoteTimerRef.current)
  }, [])
  useDerivedState(() => {
    if (doorNoteRef.current) clearDoorNote()
  }, [boardSel, region])
  useDerivedState(() => {
    if (boardArmed !== null && boardSel !== boardArmed) setBoardArmed(null)
  }, [boardSel, boardArmed])
  const [markedIds, setMarkedIds] = useState<ReadonlySet<string>>(() => new Set())
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
  const markProjectRef = useRef(snapshot.context.projectLabel)
  useDerivedState(() => {
    if (markProjectRef.current === snapshot.context.projectLabel) return
    markProjectRef.current = snapshot.context.projectLabel
    setMarkedIds(new Set())
  }, [snapshot.context.projectLabel])
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
