import { useRef, useState } from 'react'
import { useDerivedState, useTimer } from '../../../hooks/effects.js'
import { CONTROL_NOTE_REFUSED_MS, stableSelectionFallback } from '../contracts.js'
import type { OlderChatFact } from '../../../services/concourse/concourseSnapshot.js'
import { NEW_SESSION_ROW_ID } from '../ConcourseLayout.js'
import { compactParkNoteOf } from '../compactBoard.js'
import type { Filter, Frame, ScreenProps } from './state.js'

export function useConcourseSelection({ presentationCapsule, compact, newSessionLine, sessionRows }: Pick<ScreenProps, 'presentationCapsule'> & Pick<Frame, 'compact'> & Pick<Filter, 'newSessionLine' | 'sessionRows'>) {
  const [boardSel, setBoardSel] = useState<string | null>(
    () => presentationCapsule?.boardSel ?? sessionRows[0]?.sessionId ?? null,
  )
  const boardSelRef = useRef<string | null>(boardSel)
  boardSelRef.current = boardSel
  const parkSightRef = useRef(new Map<string, number>())
  const [parkNoteEpoch, setParkNoteEpoch] = useState(0)
  const compactParkNote = compact
    ? compactParkNoteOf(
        sessionRows,
        boardSel,
        key => {
          const seen = parkSightRef.current.get(key)
          if (seen !== undefined) return seen
          const at = Date.now()
          parkSightRef.current.set(key, at)
          return at
        },
        Date.now(),
        CONTROL_NOTE_REFUSED_MS,
      )
    : null
  const compactParkNoteExpiresAt = compactParkNote?.expiresAtMs ?? null
  useTimer(() => {
    if (compactParkNoteExpiresAt === null) return
    const timer = setTimeout(() => setParkNoteEpoch(epoch => epoch + 1), Math.max(0, compactParkNoteExpiresAt - Date.now()) + 1)
    timer.unref?.()
    return () => clearTimeout(timer)
  }, [compactParkNoteExpiresAt, parkNoteEpoch])
  const lastIdxRef = useRef(0)
  useDerivedState(() => {
    if (newSessionLine && boardSel === NEW_SESSION_ROW_ID) {
      lastIdxRef.current = 0
      return
    }
    const ids = sessionRows.map(r => r.sessionId)
    const fb = stableSelectionFallback(ids, boardSel, lastIdxRef.current)
    lastIdxRef.current = fb.index
    if (fb.sessionId !== boardSel) setBoardSel(fb.sessionId)
  }, [sessionRows, boardSel, newSessionLine])
  const [boardScroll, setBoardScroll] = useState<number | null>(presentationCapsule?.boardScroll ?? null)
  const [rowPeekOpen, setRowPeekOpen] = useState(false)
  const rowPeekOpenRef = useRef(false)
  rowPeekOpenRef.current = rowPeekOpen
  const [olderList, setOlderList] = useState<{ entries: OlderChatFact[]; total: number; at: number } | null>(null)
  const olderListRef = useRef<{ entries: OlderChatFact[]; total: number; at: number } | null>(null)
  olderListRef.current = olderList
  return { boardSel, setBoardSel, boardSelRef, compactParkNote, boardScroll, setBoardScroll, rowPeekOpen, setRowPeekOpen, rowPeekOpenRef, olderList, setOlderList, olderListRef }
}
